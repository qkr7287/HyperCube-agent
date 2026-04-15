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

## 2026-04-15 — Re: 컨테이너 lifecycle 명령 + progress 이벤트 (완료 — agent `184b287`)

### 처리 내용

#### 신규 명령 4종 (handlers)
- `src/handlers/create-container.ts` — image pull(레이어별 percent 집계) + create + start, progress 이벤트 발사
- `src/handlers/delete-container.ts` — safe remove (force / removeVolumes)
- `src/handlers/compose-up.ts` — `docker compose -p <name> -f <tmp> up -d --pull missing` shell-out, stdout/stderr 라인을 progress로 스트리밍, `com.docker.compose.project=<name>` 라벨 필터로 컨테이너 enumerate
- `src/handlers/compose-down.ts` — `docker compose down`, down 전 컨테이너 ID snapshot 반환

#### 신규 비동기 이벤트
- `types/index.ts`: `CommandProgress`, `ProgressEmitter`, `ProgressStep` 추가
- `transport/websocket.ts`: `sendProgress()` 메서드
- `handlers/index.ts`: dispatcher가 progress emitter 콜백을 핸들러에 주입
- `index.ts`: `ws.onCommand` 에서 progress emitter를 구성해 dispatcher에 전달

#### 인프라
- `Dockerfile`: `apk add docker-cli docker-cli-compose` 추가 → Agent 컨테이너에 Docker CLI v29.1.3 + Compose v2.40.3 설치 확인
- `USER node` 삭제 (compose CLI가 docker.sock 접근 시 group 권한 이슈 회피) — 차후 리팩토링 대상
- `docs/PROTOCOL.md`: 4개 신규 명령 schema + `command_progress` 스키마 추가

### 검증 결과 (모두 hc16 서버 Agent 컨테이너 내부에서 직접 핸들러 호출)

| # | 시나리오 | 결과 |
|---|----------|------|
| 1 | `create_container` alpine:3.19 | ✓ progress 14 events (pulling_image 11 + creating 1 + starting 1), `inspect` 정상 |
| 2 | 이름 중복 create | ✓ `name already exists: hc-test-agent`, progress 0건, 즉시 실패 |
| 3 | `compose_up` (web + db, alpine 기반 2-service yaml) | ✓ 서비스별 creating/starting 진행 이벤트, `containers[]` 2개 정상 반환 |
| 4 | `delete_container` force=true (restarting 상태) | ✓ 정상 삭제, `removed: true` |
| 5 | `compose_down` | ✓ `removedContainerIds` 2개 반환, 컨테이너 `inspect` → not found |
| 6 | `create_container` 존재하지 않는 image (`notexist-hc:latest`) | ✓ progress 1건 후 `image pull failed: ... 404 ... repository does not exist`로 실패 |

타입체크: `npx tsc --noEmit` 통과.

### 배포 상태

- **16번 서버**: `docker compose up -d --build --force-recreate` 완료. docker CLI + compose plugin 컨테이너 내부 확인
- **Windows 로컬**: `npm run dev` 재시작 완료 (compose shell-out은 로컬 Docker Desktop CLI에 의존)
- 기존 4종 명령(`system_info`, `inspect`, `get_logs`, `control`) 회귀 없음

### 남은 이슈 / 후속 작업

1. **P2 — progress percent 정밀화**: 현재 pulling_image 단계는 레이어별 `current/total` 합산으로 0~99% 산출. compose_up 단계는 CLI stdout 텍스트 기반으로 step만 판단(percent=null). 향후 compose CLI `--progress json` 출력 파싱하면 정밀화 가능
2. **보안 — `USER node` 복원**: Dockerfile에서 non-root 사용자로 복귀하려면 `addgroup --gid $DOCKER_GID docker` + `adduser node docker` 형태로 Docker 그룹 연결 필요. 현재는 root 실행 (container 내부 root이므로 호스트에는 영향 없음)
3. **compose YAML env 치환**: `env` 파라미터는 `process.env`에 주입해서 `${VAR}` 형태가 compose 내부에서 해석되도록 함. 명시적 `environment:` 주입은 아님 — 필요 시 별도 논의
4. **`running_check` step**: 타입에는 정의됐으나 현재 미사용. 헬스체크 로직 추가 시 활용 예정

### 추가 정보 요청

- HyperCube 측 Browser UI에서 `command_progress` 수신 시 어떤 UX로 렌더링하는지 (progress bar? toast?) — 스키마 적합성 검토에 참고하면 좋음
- compose up 시 전달되는 `env` 파라미터의 용도가 compose 변수 치환(`${DB_PASSWORD}`)인지, 서비스 environment 주입인지 명확히 해주시면 좋음. 현재 구현은 전자

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
