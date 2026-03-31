# HyperCube Agent - Server Monitoring Daemon

## 프로젝트 개요

모니터링 대상 서버에 설치되는 경량 Node.js 데몬.
Docker 컨테이너와 시스템 메트릭을 수집하여 Django Backend에 WebSocket으로 전송한다.

**관련 프로젝트**: `C:\Users\agics\Desktop\workspace\01. git\HyperCube` (Django Backend + Frontend)
**Backend repo**: `qkr7287/HyperCube`
**Agent repo**: `qkr7287/hypercube-agent` (이 repo)

## 기술 스택

- **Node.js 20+** (TypeScript)
- **dockerode** — Docker Engine API 클라이언트
- **ws** — WebSocket 클라이언트
- Docker 컨테이너로 배포 (docker.sock 마운트)

## 아키텍처

```
[모니터링 대상 서버]
  Agent (이 프로젝트)
    ├── Collector: Docker  ← docker.sock 또는 Docker API
    ├── Collector: System  ← /proc, /sys 직접 읽기
    ├── Diff Engine        ← 이전 스냅샷과 비교, 변경분만 추출
    └── Transport          ← WebSocket으로 Django Backend 전송

[메인 서버]
  Django Backend (DCMTool_TS)
    ├── /ws/server/<server_id>/  ← Agent WebSocket 연결
    ├── /api/agents/register     ← Agent 등록
    └── /api/auth/token/         ← JWT 발급
```

## 데이터 흐름

### 1. Agent 등록
```
Agent 시작 → POST /api/agents/register (hostname, ip)
  → status: pending → 관리자 승인 대기
  → 승인 후 JWT token 수신
```

### 2. WebSocket 연결
```
Agent → ws://backend:8000/ws/server/{agent_id}/?token=JWT
  → 연결 성공 → 전체 스냅샷 1회 전송
  → 이후 2초마다 Delta Sync (변경분만)
```

### 3. Delta Sync 프로토콜
- **평소**: 이전 스냅샷과 비교, 변경된 항목만 전송
- **재접속 시**: 전체 스냅샷 1회 전송 (정합성 보장)
- CPU 변동폭 임계값으로 노이즈 필터링

### 전송 메시지 형식
```json
{
  "type": "system",
  "serverId": "agent-uuid",
  "timestamp": "2026-03-31T10:00:00Z",
  "cpu": { "usage": 45.2, "cores": [30, 50, 40, 60] },
  "memory": { "total": 16384, "used": 8192, "percent": 50.0 },
  "disk": { "total": "500G", "used": "200G", "percent": 40 },
  "network": { "rx": 102400, "tx": 51200 },
  "containers": [
    { "id": "abc123", "name": "nginx", "status": "running", "cpu": 2.1, "memory": 128 }
  ]
}
```

## 프로젝트 구조

```
hypercube-agent/
├── src/
│   ├── index.ts              # 엔트리포인트
│   ├── config.ts             # 환경변수, 설정
│   ├── collectors/
│   │   ├── docker.ts         # Docker 데이터 수집 (dockerode)
│   │   └── system.ts         # System 메트릭 수집 (/proc)
│   ├── transport/
│   │   ├── register.ts       # Agent 등록 (REST)
│   │   └── websocket.ts      # WebSocket 연결 + 재접속
│   ├── sync/
│   │   └── delta.ts          # Delta Sync 엔진 (diff 계산)
│   └── types/
│       └── index.ts          # 공유 타입 정의
├── Dockerfile
├── docker-compose.yml        # 개발용
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

## 실행 방법

### Docker (권장)
```bash
docker run -d \
  --name hc-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /proc:/host/proc:ro \
  -v /sys:/host/sys:ro \
  -e BACKEND_URL=ws://192.168.0.16:8000 \
  -e AGENT_HOSTNAME=$(hostname) \
  hypercube-agent:latest
```

### 개발
```bash
npm install
npm run dev
```

## Backend API 연동

| Method | URL | 용도 |
|--------|-----|------|
| POST | /api/agents/ | Agent 등록 (hostname, ip_address) |
| POST | /api/agents/{id}/manage-status/ | 관리자 승인/거절 |
| POST | /api/auth/token/ | JWT 토큰 발급 |
| WS | /ws/server/{agent_id}/ | 실시간 데이터 전송 |

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| BACKEND_URL | ws://localhost:8000 | Django Backend WebSocket URL |
| BACKEND_API_URL | http://localhost:8000 | Django REST API URL |
| AGENT_HOSTNAME | (자동감지) | Agent 호스트명 |
| COLLECT_INTERVAL | 2000 | 수집 주기 (ms) |
| DOCKER_SOCKET | /var/run/docker.sock | Docker 소켓 경로 |

## WBS 작업 범위

| ID | Task | 예상 |
|----|------|------|
| 2.1.1 | 아키텍처 설계 | 2일 |
| 2.1.2 | Docker 수집 모듈 | 1.5일 |
| 2.1.3 | System 수집 모듈 | 1일 |
| 2.1.4 | Docker 이미지 빌드 | 0.5일 |
| 2.1.5 | 설치 스크립트/문서 | 0.5일 |
| 2.2.1 | 등록 프로토콜 | 0.5일 |
| 2.2.2 | 승인/거부 API + WS 알림 | 0.5일 |
| 2.2.3 | JWT + WS 연결 | 1일 |
| 2.2.4 | Heartbeat + Delta Sync | 0.5일 |
