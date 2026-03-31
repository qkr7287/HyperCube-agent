# Backend Handoff: Agent 전용 인증 API 요청

## 배경

HyperCube Agent(모니터링 데몬)가 Backend와 통신하기 위한 인증 흐름을 설계했습니다.
현재 Backend의 JWT 인증은 사용자 계정 기반(`username/password`)이므로, Agent 전용 토큰 발급 메커니즘이 필요합니다.

## 요청 사항

### 1. Agent 등록 API 수정 — 인증 없이 접근 가능하게

**현재**: `POST /api/agents/` — SuperAdmin 권한 필요
**변경**: Agent 자체가 호출하므로 **인증 없이(AllowAny)** 접근 가능해야 함

```python
# viewsets.py — permission 정책 수정
def get_permissions(self):
    if self.action == "create":
        return [AllowAny()]  # Agent 자가 등록
    elif self.action in ["destroy", "manage_status"]:
        return [IsSuperAdmin()]
    return [IsServerAdminOrAbove()]
```

**Agent가 보내는 요청:**
```
POST /api/agents/
Content-Type: application/json

{
  "hostname": "prod-server-01",
  "ip_address": "192.168.1.100"
}
```

**기대 응답 (201):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "hostname": "prod-server-01",
    "ip_address": "192.168.1.100",
    "status": "pending"
  }
}
```

**중복 등록 처리**: 같은 `hostname`으로 재등록 시도 시, 기존 Agent 정보를 반환 (409 또는 200).
Agent는 재시작될 수 있으므로 idempotent해야 함.

---

### 2. Agent 상태 조회 API — 인증 없이 접근 가능하게

Agent가 승인 여부를 polling할 수 있어야 합니다.

**변경**: `GET /api/agents/{id}/` — Agent 자신의 정보 조회 시 인증 불필요
(또는 별도 엔드포인트: `GET /api/agents/{id}/status/`)

**Agent가 보내는 요청:**
```
GET /api/agents/{id}/status/
```

**기대 응답:**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-...",
    "status": "pending",
    "token": null
  }
}
```

승인 후:
```json
{
  "success": true,
  "data": {
    "id": "550e8400-...",
    "status": "approved",
    "token": "agent_550e8400..."
  }
}
```

---

### 3. Agent 승인 시 토큰 자동 발급 — manage-status 수정

`POST /api/agents/{id}/manage-status/` 에서 `action: "approve"` 시:
1. Agent 전용 토큰을 생성하여 `Agent.token` 필드에 저장
2. 토큰은 장기 유효 (만료 없음 또는 1년 이상)

**토큰 생성 방식 제안:**

```python
# 방안 A: 단순 UUID 기반 (추천 — Agent 전용이므로 JWT 불필요)
import secrets
token = f"agent_{secrets.token_urlsafe(32)}"

# 방안 B: JWT (만료 1년)
from rest_framework_simplejwt.tokens import AccessToken
token = AccessToken()
token["agent_id"] = str(agent.id)
token.set_exp(lifetime=timedelta(days=365))
```

**manage-status 수정 예시:**
```python
@action(detail=True, methods=["post"], url_path="manage-status")
def manage_status(self, request, pk=None):
    agent = self.get_object()
    serializer = AgentApproveSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    if serializer.validated_data["action"] == "approve":
        agent.status = Agent.Status.APPROVED
        agent.approved_at = timezone.now()
        # --- 추가: Agent 토큰 발급 ---
        agent.token = f"agent_{secrets.token_urlsafe(32)}"
    else:
        agent.status = Agent.Status.REJECTED
        agent.token = ""  # 거절 시 토큰 삭제

    agent.save(update_fields=["status", "approved_at", "token"])
    return Response(AgentSerializer(agent).data)
```

---

### 4. WebSocket 인증 미들웨어 수정 — Agent 토큰 지원

현재 `JWTAuthMiddleware`는 JWT에서 `user_id`를 추출합니다.
Agent 토큰도 인증할 수 있도록 수정이 필요합니다.

**수정 방향:**

```python
# middleware.py
class JWTAuthMiddleware(BaseMiddleware):
    async def __call__(self, scope, receive, send):
        query_string = scope.get("query_string", b"").decode()
        params = parse_qs(query_string)
        token_list = params.get("token", [])

        if token_list:
            token_str = token_list[0]
            if token_str.startswith("agent_"):
                # Agent 토큰 인증
                scope["user"] = await get_agent_from_token(token_str)
                scope["is_agent"] = True
            else:
                # 기존 JWT 사용자 인증
                scope["user"] = await get_user_from_token(token_str)
                scope["is_agent"] = False
        else:
            scope["user"] = AnonymousUser()

        return await super().__call__(scope, receive, send)


@database_sync_to_async
def get_agent_from_token(token_str):
    """Agent 토큰으로 인증 — Agent를 user-like 객체로 래핑"""
    from apps.agents.models import Agent

    try:
        agent = Agent.objects.get(token=token_str, status="approved")
        # AnonymousUser가 아닌, is_authenticated=True인 객체 반환 필요
        # 방법 1: SimpleNamespace 래핑
        # 방법 2: Agent 모델에 is_authenticated 프로퍼티 추가
        return AgentUser(agent)
    except Agent.DoesNotExist:
        return AnonymousUser()


class AgentUser:
    """Agent를 Django User처럼 보이게 하는 래퍼"""
    def __init__(self, agent):
        self.agent = agent
        self.id = agent.id
        self.is_authenticated = True
```

---

### 5. Consumer 수정 — Agent/Browser 구분

Agent가 보낸 데이터만 브로드캐스트하고, Browser는 수신만 하도록 구분하면 보안상 좋습니다. (선택사항)

```python
async def receive(self, text_data):
    # Agent만 데이터 전송 가능
    if not getattr(self.scope, "is_agent", False):
        await self.send(text_data=json.dumps({"error": "Only agents can send data"}))
        return
    # ... 기존 브로드캐스트 로직
```

---

## Agent 측 동작 정리

```
1. POST /api/agents/          → 등록 (AllowAny)
2. GET  /api/agents/{id}/status/ → 승인 polling (AllowAny, 10초 간격)
3. 승인 확인 → token 수신
4. ws://backend/ws/server/{agent_id}/?token=agent_xxx → WebSocket 연결
5. JSON 메시지 전송 시작
```

## Agent가 보내는 WebSocket 메시지 형식

```json
{
  "type": "system_metrics",
  "data": {
    "cpu": { "usage": 45.2, "cores": [30, 50, 40, 60] },
    "memory": { "total": 16384, "used": 8192, "percent": 50.0 },
    "disk": { "total": 512000, "used": 204800, "percent": 40.0 },
    "network": { "rx": 102400, "tx": 51200 },
    "timestamp": "2026-03-31T10:00:00Z"
  }
}

{
  "type": "containers",
  "data": {
    "containers": [
      {
        "container_id": "abc123def456",
        "name": "nginx",
        "image": "nginx:latest",
        "status": "running",
        "cpu": 2.1,
        "memory": { "usage": 134217728, "limit": 536870912, "percent": 25.0 },
        "network": { "rx": 2048, "tx": 1024 }
      }
    ],
    "timestamp": "2026-03-31T10:00:00Z"
  }
}
```

## 우선순위

| 순서 | 작업 | 필수 여부 |
|------|------|-----------|
| 1 | Agent 등록 AllowAny + 중복 처리 | 필수 |
| 2 | manage-status에서 토큰 자동 발급 | 필수 |
| 3 | Agent 상태/토큰 조회 엔드포인트 | 필수 |
| 4 | WebSocket 미들웨어 Agent 토큰 지원 | 필수 |
| 5 | Consumer Agent/Browser 구분 | 권장 |
