# HyperCube Agent

모니터링 대상 서버에 설치되는 Node.js 20+ 데몬. dockerode + ws로 Docker/시스템 메트릭을 Django Backend에 송출.

**Repo 분담**:
- **이 repo (`qkr7287/hypercube-agent`)** — Agent만 개발. 본 작업 범위.
- **`qkr7287/HyperCube`** (Backend + Frontend) — **다른 개발자 담당**. 옆 워크스페이스(`C:\Users\agics\Desktop\workspace\01. git\HyperCube`)에 클론돼 있어도 **읽기 전용**. 수정·커밋·PR 금지. 변경이 필요해 보이면 사용자에게 문의해 backend 측 작업으로 분리.

## 핵심 룰 (반복 실수 방지)

- **HyperCube ↔ Agent 작업 요청은 GitHub Issues로 트래킹** (이 repo의 Issues가 single source of truth). HyperCube 측 commit message에 `qkr7287/hypercube-agent#NN` 또는 `Closes qkr7287/hypercube-agent#NN`로 연결. mailbox 파일 방식은 2026-05-08 폐기.
- **로컬에서 dev 실행 금지** (`npm run dev` 금지). dev는 63번에서 동작 (16 폐기). `scripts/dev-on.sh <63>` → Mutagen 세션(`agent-63`) → 원격에서 `docker-compose.dev.yml` 빌드/기동. 정리는 `dev-off.sh`. (`docs/dev-remote.md`)
- **dev 작업 중엔 commit / PR / main push 금지**. main push만이 deploy를 트리거하므로, 사용자가 명시 요청한 경우에만 실행. (`memory: feedback_dev_workflow`)
- **배포 흐름**: `main` push → GitHub Actions `verify`(tsc + build, Node 20) → self-hosted runner(`lan-runner`, **63번 `hc63-agent-runner`**)에서 **41 → 63 순차** 배포 (`max-parallel: 1, fail-fast`). 각 호스트에서 `git reset --hard origin/main && docker compose -p hypercube-agent-prod up -d --build` 후 `Sent N messages|Collecting every` 로그로 헬스체크. (16번은 2026-05 matrix 에서 제거됨)
- Agent 컨테이너는 **`network_mode: host` + `privileged` + `pid: host`**, `docker.sock` ro, `/proc:/host/proc:ro`, `/var/run/utmp:ro`, `/etc/hostname:/host/etc/hostname:ro`, **`/var/lib/hypercube-agent/model-cache` rw** 마운트. 등록 시 `ip_address` 미전송 → backend가 TCP peer로 추론. NAT/VPN에서만 `AGENT_ADVERTISE_IP` override.
- **`DOCKER_GID`는 호스트별 다름** (41:999, 63:138, edgexpert-4cc8:988). `.env`에 명시. group_add로 docker.sock 접근 권한 확보.
- Docker socket 경로 OS별: Linux `/var/run/docker.sock`, Windows `//./pipe/docker_engine`.
- **Windows autocrlf 함정**: `.sh` 파일이 CRLF면 Linux 컨테이너 무한 재시작. `.gitattributes`에 `*.sh text eol=lf` 보장. (`memory: debug_crlf_mutagen_trap`)
- Docker json-file 로그는 compose에서 **20MB × 10**로 cap. 호스트 unbounded log 방지.
- GPU per-container source 자동 전환: `DCGM-MIG → pmon → host-util-solo`. RTX는 idle에 pmon이 sm 차단 = 정상. (`memory: nvidia_rtx_pmon_behavior`)
- **GPU prod 호스트는 `.env`에 `AGENT_RUNTIME=nvidia` 필수**. compose 가 `runtime: ${AGENT_RUNTIME:-runc}` 로 default runc 를 명시하므로, daemon 의 `default-runtime: nvidia` 가 있어도 compose 값에 override 됨 → nvidia-container-toolkit hook 미발동 → `nvidia-smi` 미주입 → agent 가 lspci/sysfs fallback 으로 `"GA104 [GeForce RTX 3060 Ti]"` 같은 PCI ID 송신 + memory/power/temp 누락. 증상이 보이면 첫 점검: `docker inspect <agent> --format '{{.HostConfig.Runtime}}'` 결과가 `nvidia` 인지 확인.
- 첫 systeminformation 호출은 Windows에서 3~5초 → 첫 스냅샷 타임아웃 없이 대기.
- serena LSP TypeScript 활성. 80줄+ 파일은 `get_symbols_overview` → `find_symbol` 우선.

## 작업별 doc 인덱스 (필요 시 읽기)

- WS 프로토콜 (commands / container_events / logs stream / payload v3 + workspace): `docs/PROTOCOL.md`
- 원격 dev (Mutagen + dev-on/off/supervisor): `docs/dev-remote.md`
- Air-gap installer (slim/full, RHEL·Rocky, bundled Docker, 결정 매트릭스): `docs/airgap-install.md`
- 배포 runbook (호스트·시점별 단발 노트): `docs/deployments/<date>.md`

## 아키텍처

```
src/
├── collectors/   docker.ts, docker-events.ts, system.ts, gpu-per-container.ts, capacity.ts (capacity_report)
├── handlers/     control, inspect, logs, system-info, create/update/delete-container, compose-up/down, prepare-model-assets, container-processes, image-inspect
├── streaming/    log-stream-registry.ts (live log follow, frame demux, idle TTL)
├── sync/         delta.ts (변경분 + 60s 주기 full snapshot, workspace 포함)
├── transport/    register.ts (REST), websocket.ts (재접속 + 큐잉)
├── utils/        gpu-{dcgm,mig,pmon,cgroup,topology}, container-cpu-quota, cpu-topology, utmp, workspace-usage (du -sk + TTL cache), model-cache, command-runner
├── workspace-quota.ts   XFS prjquota provisioning (WorkspaceQuotaManager) — dormant until WORKSPACE_QUOTA_ENABLED
└── types/
```

데이터 흐름: 등록(REST `/api/agents/`) → 승인 후 JWT 발급 → WS 연결 → 첫 full snapshot + capacity_report → 2초 주기 delta + 컨테이너 이벤트 push + 명령 응답/진행상황 + 1h 주기 capacity_report. payload contract v3.

## 환경 정보

| 호스트 | 용도 | SSH alias | prod 경로 (deploy.yml) | dev 경로 (dev-on.sh) | DOCKER_GID | GPU runtime 패턴 |
|--------|------|-----------|------------------------|----------------------|------------|------------------|
| 16번 (Mac mini) | (구) — **2026-05 폐기, host unreachable**. deploy matrix 에서 제거됨 | `hc16` | — | — | — | — |
| 41번 | prod + dev | `hc41` | `/home/stdt/docker/hypercube-agent` (root) | `/home/stdt/docker/hypercube-agent-dev` (root) | 999 | `.env` 에 `AGENT_RUNTIME=nvidia` (daemon default-runtime 없음) |
| 63번 | **prod backend + dev backend + agent(prod/dev) 통합** + lan-runner | `hc-dev-63` | `/docker/hypercube-agent` (agics) | `/home/agics/ts/agent-dev` | 138 | `.env` 에 `AGENT_RUNTIME=nvidia` (daemon default 도 nvidia 라 override 필수) |
| edgexpert-4cc8 (32번 DGX Spark) | prod (수동 install, deploy.yml matrix 밖) | (사용자 키 등록 후 dcmtool_sync) | `~/Desktop/Hypercube/hypercube-agent` (psj) | — | 988 | `docker-compose.override.yml` 의 `deploy.resources.reservations.devices` (daemon 에 nvidia runtime 미등록) |

모두 SSH port `2022` (edgexpert-4cc8 만 `22`).

**Backend 엔드포인트 (2026-05~)**:
- **prod**: `http://192.168.0.63:37003` / `ws://192.168.0.63:37003` (nginx → backend:8000 reverse proxy, project `hypercube-prod`, 컨테이너 prefix `hcprod-*`)
- **dev**: `http://192.168.0.63:38000` / `ws://192.168.0.63:38000` (project `hypercube`, 컨테이너 prefix `hc-*`)
- 기본 host port 매핑: postgres `35432`, redis `36379`, backend `38000`, frontend `33000`, prod nginx `37003` (HyperCube 측 `5432/6379/8000/3000/7003`에 `3` prefix).
- (구) prod `192.168.0.16:3334` 는 종료.

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
| `AGENT_RUNTIME` | (없음→runc) | GPU 호스트는 `nvidia` 필수 (compose `runtime`). [[debug_compose_runtime_override]] |
| `WORKSPACE_QUOTA_ENABLED` | false | XFS prjquota 볼륨 provisioning 활성. 호스트 인프라(loop file + prjquota mount) 선행 필요 |
| `WORKSPACE_QUOTA_MOUNT` | `/var/lib/hypercube/workspaces` | prjquota XFS 마운트 루트. agent 컨테이너에도 bind mount 돼야 함 |
| `MODEL_CACHE_ROOT` | `/var/lib/hypercube-agent/model-cache` | 모델 자산 캐시. host bind mount 필수 |

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
| prod GPU 가 lspci fallback (model="GA104 [...]") | compose `runtime: ${AGENT_RUNTIME:-runc}` 가 daemon default override | `.env` 에 `AGENT_RUNTIME=nvidia` ([[debug_compose_runtime_override]]) |
| `prepare_model_assets` 4초 noop, bytes_done=0 stuck | model-cache 가 host bind mount 안 됨 → agent writable layer 안에만 download | compose 에 `/var/lib/hypercube-agent/model-cache:/var/lib/hypercube-agent/model-cache` 추가 (PR #23) |
| nvidia-smi 실행 실패 (`no such file or directory` 인데 binary 존재) | prod base image 가 musl (Alpine), nvidia-smi 는 glibc 바이너리 | prod Dockerfile 도 `node:20-bookworm-slim` (PR #21) |

## 현황 / 진행 상황

`MEMORY.md` 참조. CLAUDE.md엔 시점성 정보(Current Work, 다음 작업) 안 적음.
