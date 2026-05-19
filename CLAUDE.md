# HyperCube Agent

모니터링 대상 서버에 설치되는 Node.js 20+ 데몬. dockerode + ws로 Docker/시스템 메트릭을 Django Backend에 송출.

**Repo 분담**:
- **이 repo (`qkr7287/hypercube-agent`)** — Agent만 개발. 본 작업 범위.
- **`qkr7287/HyperCube`** (Backend + Frontend) — **다른 개발자 담당**. 옆 워크스페이스(`C:\Users\agics\Desktop\workspace\01. git\HyperCube`)에 클론돼 있어도 **읽기 전용**. 수정·커밋·PR 금지. 변경이 필요해 보이면 사용자에게 문의해 backend 측 작업으로 분리.

## 핵심 룰 (반복 실수 방지)

- **HyperCube ↔ Agent 작업 요청은 GitHub Issues로 트래킹** (이 repo의 Issues가 single source of truth). HyperCube 측 commit message에 `qkr7287/hypercube-agent#NN` 또는 `Closes qkr7287/hypercube-agent#NN`로 연결. mailbox 파일 방식은 2026-05-08 폐기.
- **로컬에서 dev 실행 금지** (`npm run dev` 금지). dev는 16/63번에서 동작. `scripts/dev-on.sh <16|63>` → Mutagen 세션(`agent-{16|63}`) → 원격에서 `docker-compose.dev.yml` 빌드/기동. 정리는 `dev-off.sh`. (`docs/dev-remote.md`)
- **dev 작업 중엔 commit / PR / main push 금지**. main push만이 deploy를 트리거하므로, 사용자가 명시 요청한 경우에만 실행. (`memory: feedback_dev_workflow`)
- **배포 흐름**: `main` push → GitHub Actions `verify`(tsc + build, Node 20) → self-hosted runner(`lan-runner`, 16번)에서 **16 → 41 → 63 순차** 배포 (`max-parallel: 1, fail-fast`). 각 호스트에서 `git reset --hard origin/main && docker compose -p hypercube-agent-prod up -d --build` 후 `Sent N messages|Collecting every` 로그로 헬스체크.
- Agent 컨테이너는 **`network_mode: host` + `privileged` + `pid: host`**, `docker.sock` ro, `/proc:/host/proc:ro`, `/var/run/utmp:ro`, `/etc/hostname:/host/etc/hostname:ro` 마운트. 등록 시 `ip_address` 미전송 → backend가 TCP peer로 추론. NAT/VPN에서만 `AGENT_ADVERTISE_IP` override.
- **`DOCKER_GID`는 호스트별 다름** (16:999, 63:138). `.env`에 명시. group_add로 docker.sock 접근 권한 확보.
- Docker socket 경로 OS별: Linux `/var/run/docker.sock`, Windows `//./pipe/docker_engine`.
- **Windows autocrlf 함정**: `.sh` 파일이 CRLF면 Linux 컨테이너 무한 재시작. `.gitattributes`에 `*.sh text eol=lf` 보장. (`memory: debug_crlf_mutagen_trap`)
- Docker json-file 로그는 compose에서 **20MB × 10**로 cap. 호스트 unbounded log 방지.
- GPU per-container source 자동 전환: `DCGM-MIG → pmon → host-util-solo`. RTX는 idle에 pmon이 sm 차단 = 정상. (`memory: nvidia_rtx_pmon_behavior`)
- 첫 systeminformation 호출은 Windows에서 3~5초 → 첫 스냅샷 타임아웃 없이 대기.
- serena LSP TypeScript 활성. 80줄+ 파일은 `get_symbols_overview` → `find_symbol` 우선.

## 작업별 doc 인덱스 (필요 시 읽기)

- WS 프로토콜 (commands / container_events / logs stream / payload v3): `docs/PROTOCOL.md`
- Backend 등록·JWT·승인 흐름: `docs/backend-handoff.md`
- 원격 dev (Mutagen + dev-on/off/supervisor): `docs/dev-remote.md`
- Air-gap installer (slim/full, RHEL·Rocky, bundled Docker, 결정 매트릭스): `docs/airgap-install.md`
- 배포 runbook: `docs/deployments/<date>.md`

## 아키텍처

```
src/
├── collectors/   docker.ts, docker-events.ts, system.ts, gpu-per-container.ts
├── handlers/     control, inspect, logs, system-info, create/delete-container, compose-up/down
├── streaming/    log-stream-registry.ts (live log follow, frame demux, idle TTL)
├── sync/         delta.ts (변경분 + 60s 주기 full snapshot)
├── transport/    register.ts (REST), websocket.ts (재접속 + 큐잉)
├── utils/        gpu-{dcgm,mig,pmon,cgroup,topology}, container-cpu-quota, cpu-topology, utmp
└── types/
```

데이터 흐름: 등록(REST `/api/agents/`) → 승인 후 JWT 발급 → WS 연결 → 첫 full snapshot → 2초 주기 delta + 컨테이너 이벤트 push + 명령 응답/진행상황. payload contract v3.

## 환경 정보

| 호스트 | 용도 | SSH alias | prod 경로 (deploy.yml) | dev 경로 (dev-on.sh) | DOCKER_GID |
|--------|------|-----------|------------------------|----------------------|------------|
| 16번 (Mac mini) | (구) prod + self-hosted runner + dev — **2026-05 prod backend 종료, host 자체도 unreachable** | `hc16` | `/home/agics-ai/docker/hypercube-agent` (root) | `/home/agics-ai/ts/agent-dev` | 999 |
| 41번 | prod | — | `/home/stdt/docker/hypercube-agent` (root) | (미설정) | — |
| 63번 | **prod backend + dev backend + agent(prod/dev) 통합** | `hc-dev-63` | `/docker/hypercube-agent` (agics) | `/home/agics/ts/agent-dev` | 138 |

모두 SSH port `2022`.

**Backend 엔드포인트 (2026-05~)**:
- **prod**: `http://192.168.0.63:37003` / `ws://192.168.0.63:37003` (nginx → backend:8000 reverse proxy, project `hypercube-prod`, 컨테이너 prefix `hcprod-*`)
- **dev**: `http://192.168.0.63:38000` / `ws://192.168.0.63:38000` (project `hypercube`, 컨테이너 prefix `hc-*`)
- 기본 host port 매핑: postgres `35432`, redis `36379`, backend `38000`, frontend `33000`, prod nginx `37003` (HyperCube 측 `5432/6379/8000/3000/7003`에 `3` prefix).
- (구) prod `192.168.0.16:3334` 는 종료. PR-merge → deploy.yml 흐름 재검토 필요 (16번 unreachable 이면 self-hosted runner / 16/41 deploy 도 영향).

## 주요 명령

| 명령 | 용도 |
|------|------|
| `npm run typecheck` | `tsc --noEmit` (CI `verify`와 동일) |
| `npm run build` | `dist/` 생성 |
| `scripts/dev-on.sh <16\|63>` | 원격 dev 컨테이너 기동 (Mutagen sync 포함) |
| `scripts/dev-off.sh <16\|63>` | 원격 dev 컨테이너·세션 정리 |
| `scripts/build-installer.sh` | air-gap installer 산출 |

## 환경변수 (주요)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `BACKEND_URL` | (필수) | Django WS URL (`ws://...`) |
| `BACKEND_API_URL` | (필수) | Django REST URL |
| `AGENT_HOSTNAME` | (자동감지) | `/host/etc/hostname` → `os.hostname()` |
| `COLLECT_INTERVAL` | 2000 | 수집 주기(ms), 최소 500 |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | OS별 다름 |
| `DOCKER_GID` | 999 | 호스트 docker 그룹 GID (compose `group_add`) |
| `LOG_LEVEL` | info | logger.ts |
| `HOST_PROC_PATH` | /proc | 컨테이너 배포 시 `/host/proc` |
| `AGENT_ADVERTISE_IP` / `HOST_IP` | (없음) | 등록 payload IP override |
| `GPU_PER_CONTAINER_ENABLED` | true | GPU 귀속 측정 |
| `DCGM_EXPORTER_URL` | (없음) | DCGM-exporter 스크레이프 URL |

## 과거 이슈 (반복 방지)

| 이슈 | 원인 | 해결 |
|------|------|------|
| WS 1012 끊김 | Backend hot-reload | 자동 reconnect (운영상 무해) |
| dev 컨테이너 무한 재시작 | Windows autocrlf로 `.sh` CRLF | `.gitattributes` `*.sh text eol=lf` |
| 첫 systeminformation 3~5초 | Windows 초기화 | 첫 스냅샷 타임아웃 없이 대기 |
| V8 OOM | docker.stats() promise 누수 | dispose 패턴 |
| 컨테이너 network rx/tx 0 | 측정 누락 | per-network stats |
| RTX pmon idle에 sm 차단 | 정상 (RTX 동작 특성) | 자동 source 전환 |
| docker json-file 로그 폭주 | unbounded | compose에 max-size/max-file 박음 |

## 현황 / 진행 상황

`MEMORY.md` 참조. CLAUDE.md엔 시점성 정보(Current Work, 다음 작업) 안 적음.
