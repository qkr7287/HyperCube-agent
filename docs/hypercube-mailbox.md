# HyperCube Mailbox (Agent → HyperCube)

Agent(`qkr7287/HyperCube-agent`)가 `qkr7287/HyperCube`로 보내는
**outbox**. 이 파일에는 Agent 측이 HyperCube 측에 회신하거나
공지하는 항목만 들어간다. 반대 방향(HyperCube → Agent)은
HyperCube repo에 별도 mailbox가 있다.

| 방향 | 위치 | 작성자 |
|---|---|---|
| HyperCube → Agent | `qkr7287/HyperCube/docs/agent-mailbox.md` | HyperCube |
| Agent → HyperCube | `qkr7287/HyperCube-agent/docs/hypercube-mailbox.md` (이 파일) | Agent |

원칙: **각 측은 자기 repo의 mailbox에만 쓴다**. 상대방은 읽기만.

URL (이 mailbox):
<https://github.com/qkr7287/HyperCube-agent/blob/main/docs/hypercube-mailbox.md>

## 우편함 규칙

- **새 항목은 최상단**. 시간 역순
- 헤더 형식: `## YYYY-MM-DD — Re: <원본 제목> (완료 — <agent commit hash>)`
- 본문 포함 사항:
  - 처리 커밋 hash
  - 검증 결과 (통과/실패 시나리오)
  - 추가 정보 요청 또는 후속 이슈
- 완료 항목은 보존 (히스토리). 삭제 금지

---

## 2026-04-15 — Re: 자동 승인 흐름 전환 (완료 — agent `beded33`)

### 처리 내용

- `src/transport/register.ts`: `pollApproval()` 함수와 `POLL_INTERVAL` 상수 완전 제거
- `src/index.ts`: polling 호출 경로 삭제. register 응답의 token 즉시 사용
- Token이 응답에 없으면 명시적 에러로 실패 (`Registration response missing token. Backend must auto-approve.`)
- `check_status` dead code 정리 완료 (P2까지 처리)

### 검증 결과

#### 시나리오 1: 16번 서버 재배포 (기존 agent)
- 기존 `.env` 유지 상태에서 `docker compose up --build --force-recreate`
- 로그: `Agent registered: e08dbdde-... (approved)` → 즉시 WS 연결
- "Waiting for admin approval..." 로그 사라짐 확인
- 데이터 송신 정상 (분당 13~20 messages)

#### 시나리오 2: Windows 로컬 Agent (신규 등록)
- 새 hostname `local-windows`로 깨끗한 상태 등록
- 로그: `Agent registered: 121a4019-... (approved)` → polling 단계 0회
- 등록부터 첫 snapshot 송신까지 **~500ms** (네트워크 지연 포함)
- 이전 대비 `Waiting for admin approval` 10초 이상 단축

#### 시나리오 3: 빌드 검증
- `npx tsc --noEmit` 통과
- `pollApproval` export 제거에 따른 참조 오류 없음

### 추가 정보

- `types/index.ts`의 `AgentStatus = "pending" | "approved" | "rejected"`는 현재 유지 (Backend 응답 타입 호환). 차기 리팩토링에서 `"approved"`만 남길지 검토 예정
- Register 응답 파싱 wrapper는 기존 `{ data: AgentRegistration }` 포맷 그대로 유지 (현재 Backend 응답과 일치 확인)

### 후속 이슈

- 없음. 기존 동작과 완전 하위 호환 (기존 hc16 Agent는 재배포 시 자동 전환)
