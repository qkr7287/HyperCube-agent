# Air-Gapped Installation Guide

폐쇄망 서버에 HyperCube Agent를 설치하는 절차입니다. 인터넷이 안 되는 환경에서도 단일 파일(`.sh`)만 USB로 반입하면 끝납니다. **Docker가 안 깔린 깡통 Ubuntu에서도 작동합니다** — 인스톨러가 자체 번들 .deb로 Docker도 같이 설치합니다.

## 0. 흐름 한눈에

```
[외부망 빌드 PC]                     [USB]                [폐쇄망 서버]
  build-installer.sh
   ├ docker build (Agent 이미지)
   ├ fetch-docker-debs.sh    ──→  installer.sh   ──→  sudo ./installer.sh
   │  (Docker .deb 다운)            (~169MB)            (인터랙티브 입력)
   └ self-extract 패킹                                  ↓
                                                Docker 자동 설치 (없으면)
                                                       ↓
                                                Agent 컨테이너 기동
```

## 1. 폐쇄망 서버 사전 조건

타겟이 **Ubuntu 24.04 LTS amd64**라면 다음만 있으면 됩니다.

| 도구 | 확인 명령 | 비고 |
|---|---|---|
| `bash` | `bash --version` | 5.x — Ubuntu 기본 |
| `tar` | `tar --version` | Ubuntu 기본 (Essential 패키지) |
| `dpkg` | `dpkg --version` | Debian 계열 기본 |
| `systemd` | `systemctl --version` | Ubuntu 기본 (부팅 시 자동 시작용) |

**없어도 인스톨러가 알아서 까는 것**:
- Docker Engine
- docker compose 플러그인
- containerd, runc, buildx 등 Docker 의존 패키지

**여전히 필요한 것** (Agent가 못 까는 영역):
- GPU 모니터링 시: NVIDIA 드라이버 + `nvidia-container-toolkit` (호스트 사전 설치)

권한:
- `root` 또는 `sudo` 필요

## 2. 빌드 PC (외부망)에서 인스톨러 만들기

```bash
git clone https://github.com/qkr7287/hypercube-agent.git
cd hypercube-agent

# 단일 파일 인스톨러 빌드 (Docker 번들 포함)
bash scripts/build-installer.sh

# 산출물
ls dist-installer/
# → hypercube-agent-installer-1.0.0.sh   (~169MB)
```

이 한 파일에 다음이 모두 들어 있습니다:
- Agent 이미지 (Agent 코드 + node_modules + native bindings + alpine 베이스)
- Docker Engine + cli + containerd + compose 플러그인 + 전이 의존성 .deb
- 설치 로직 (자기 압축 해제 + Docker 자동 설치 + .env 생성 + systemd 등록)

### 빌드 옵션

| 환경변수 | 효과 |
|---|---|
| `HC_BUNDLE_DOCKER=0 bash scripts/build-installer.sh` | Docker 번들 빠짐 → 약 84MB. 타겟에 Docker 사전 설치 전제. |
| (기본) | Docker 번들 포함 → 약 169MB. 깡통 Ubuntu에서도 동작. |

### Docker .deb만 따로 받기

```bash
bash scripts/fetch-docker-debs.sh
# → dist-installer/docker-debs/*.deb (~86MB, 19개 파일)
```

build-installer.sh가 이 디렉터리에 캐시된 .deb를 자동으로 재사용합니다. 한 번 받아두면 다음 빌드는 재다운로드 없이 즉시 패킹.

## 3. USB로 반입

```bash
cp dist-installer/hypercube-agent-installer-1.0.0.sh /media/usb/
```

폐쇄망 서버로 옮기고 임의 디렉터리에 둡니다 (예: `/root/`).

## 4. 폐쇄망 서버에서 실행

### 인터랙티브 (권장)

```bash
sudo ./hypercube-agent-installer-1.0.0.sh
```

다음 항목을 차례로 묻습니다:

```
Backend WebSocket URL [ws://192.168.0.16:8000]: ws://10.0.1.20:8000
Backend REST API URL  [http://10.0.1.20:8000]:
Agent hostname        [srv-prod-01]:
Enable per-container GPU monitoring? (y/n) [y]:
Auto-start on boot via systemd? (y/n) [y]:
Proceed? [Y/n]:
```

기본값(`[ ]` 안)은 Enter로 그대로 받습니다. `Backend REST API URL`은 WebSocket URL을 자동으로 http(s)로 변환해 추천값으로 표시합니다.

Docker가 없으면 자동으로:
1. 번들된 .deb를 `dpkg -i`로 설치
2. `systemctl start docker` (또는 systemd 없으면 `dockerd` 직접 기동)
3. Agent 이미지 로드 + 컨테이너 기동

진행 로그 예시:

```
[*] Pre-flight checks...                      OK
[*] Extracting bundled payload...             OK (169M)
[*] Docker not found. Installing bundled .debs...  OK
[*] Loading agent image into Docker...        OK
[*] Writing /opt/hypercube-agent/...          OK
[*] Starting agent...                         OK
[OK] Install complete.
```

### 비대화(스크립트/CI)

환경변수로 모든 응답을 미리 지정할 수 있습니다.

```bash
sudo HC_BACKEND_URL=ws://10.0.1.20:8000 \
     HC_BACKEND_API_URL=http://10.0.1.20:8000 \
     HC_AGENT_HOSTNAME=srv-prod-01 \
     HC_GPU_ENABLED=y \
     HC_AUTO_START=y \
     HC_ASSUME_YES=1 \
     ./hypercube-agent-installer-1.0.0.sh
```

| 환경변수 | 값 |
|---|---|
| `HC_BACKEND_URL` | `ws://...` 또는 `wss://...` |
| `HC_BACKEND_API_URL` | `http://...` 또는 `https://...` |
| `HC_AGENT_HOSTNAME` | 임의 문자열 (미지정 시 hostname 사용) |
| `HC_GPU_ENABLED` | `y` 또는 `n` |
| `HC_AUTO_START` | `y` 또는 `n` (systemd) |
| `HC_ASSUME_YES` | `1` 설정 시 최종 확인 프롬프트 자동 승인 |

### 설치 결과

```
/opt/hypercube-agent/
├── .env                      # 600 권한
└── docker-compose.yml

/etc/systemd/system/
└── hypercube-agent.service   # systemd 등록 시
```

이미지는 호스트 Docker에 `hypercube-agent:1.0.0` 태그로 로드됩니다.

## 5. 설치 후 확인

### 컨테이너 상태

```bash
docker ps --filter name=hypercube-agent
docker logs -f hypercube-agent
```

기대 로그:
```
[INFO] [agent] Starting HyperCube Agent (srv-prod-01)
[INFO] [docker] Docker connection established.
[INFO] [register] Registering with backend...
[INFO] [register] Registration accepted (status: pending)
```

### Backend 승인

신규 Agent는 `pending` 상태로 등록됩니다. Backend 관리자 페이지에서 승인해야 데이터 전송이 시작됩니다.

```
HyperCube 관리자 페이지 → Servers → Pending → 승인
```

승인 후 약 2초 안에 첫 스냅샷이 전송됩니다.

### systemd 동작 확인

```bash
sudo systemctl status hypercube-agent
sudo systemctl is-enabled hypercube-agent   # → enabled
```

## 6. 일상 운영

| 동작 | 명령 |
|---|---|
| 상태 | `docker ps --filter name=hypercube-agent` |
| 로그 (실시간) | `docker logs -f hypercube-agent` |
| 재시작 | `sudo systemctl restart hypercube-agent` |
| 중지 | `sudo systemctl stop hypercube-agent` |
| 설정 변경 | `/opt/hypercube-agent/.env` 편집 → `systemctl restart hypercube-agent` |
| 업그레이드 | 새 인스톨러 받아서 그대로 실행 (덮어쓰기) |
| 제거 | `systemctl stop hypercube-agent && rm -rf /opt/hypercube-agent /etc/systemd/system/hypercube-agent.service && docker rmi hypercube-agent:1.0.0` |

## 7. 트러블슈팅

### 인스톨러 첫머리에서 즉시 실패

```
[X] Missing required command: tar
```
→ `apt-get install -y tar` (거의 발생 안 함 — Ubuntu 기본 포함)

```
[X] Missing required command: dpkg
    Bundled .debs require Debian/Ubuntu (dpkg). For other distros, install Docker manually first.
```
→ RHEL/Rocky 등 비-Debian 호스트에서 발생. `HC_BUNDLE_DOCKER=0`로 빌드된 슬림 인스톨러를 사용하고, Docker는 해당 배포판 방식으로 사전 설치하세요.

### Docker .deb 설치 단계에서 실패

```
[X] dpkg failed to install bundled .debs after retries.
```
→ 인스톨러가 `dpkg -i` 두 번 + `dpkg --configure -a`까지 시도하고도 실패한 경우. 배포판 또는 버전 불일치 가능성:
1. 타겟이 진짜 Ubuntu 24.04 amd64인지 확인 (`. /etc/os-release && echo $VERSION_CODENAME` → `noble`)
2. 빌드 시 `fetch-docker-debs.sh`가 같은 코드네임 기준으로 .deb를 받았는지 확인

### Agent가 Backend 연결 실패만 반복

```
[ERROR] [register] Connection failed: fetch failed. Retrying in 30s...
```

체크 순서:
1. `/opt/hypercube-agent/.env`의 `BACKEND_URL`이 실제 Backend 주소와 일치하는지
2. 호스트에서 `curl -v $BACKEND_API_URL/api/agents/` 응답 오는지 (방화벽)
3. Backend 컨테이너가 떠 있는지

### GPU가 잡히지 않음

```
[WARN] [gpu-pmon] nvidia-smi unavailable
```
→ 호스트에 NVIDIA 드라이버 + `nvidia-container-toolkit` 설치 필요. Agent가 설치할 수 없는 부분입니다.

```
[DEBUG] [gpu-pmon] pmon returned empty (idle)
```
→ 정상. GPU에 부하가 없을 때 RTX 계열은 sm 측정을 차단합니다. 부하 발생 시 자동으로 정상 측정.

### 인스톨러가 "payload marker not found"로 실패

빌드 도중 인스톨러 파일이 손상됐거나, 텍스트 모드로 전송돼서 바이너리가 깨졌을 가능성. USB 복사 시 **반드시 바이너리 그대로** 옮기세요. 의심되면 빌드 PC에서 `sha256sum`을 비교하세요.

### Docker 데몬이 안 떠 있다는 에러

```
[X] Docker daemon never came up. Last log:
```
→ 인스톨러가 `dockerd`를 띄우려 했지만 실패. 로그(`/tmp/hc-dockerd.log`)에서 원인 확인. 흔한 원인:
- 컨테이너 환경에서 `--privileged` 없이 실행 → 베어메탈 호스트에선 발생 안 함
- 기존에 다른 dockerd가 떠 있어서 socket 충돌 → `pkill dockerd` 후 재시도

## 부록 A — 비-Ubuntu 호스트에 수동 설치 (RHEL/Rocky 등)

번들된 .deb는 Debian 계열 전용입니다. RHEL/Rocky/Alma에선:

1. **빌드 PC에서**: `HC_BUNDLE_DOCKER=0 bash scripts/build-installer.sh` (84MB 슬림 인스톨러)
2. **타겟에**: `dnf install -y` 등 배포판 방식으로 Docker 먼저 설치
3. **설치**: 슬림 인스톨러 실행

## 부록 B — NVIDIA Container Toolkit 오프라인 설치 (GPU 호스트만)

GPU 모니터링이 필요한 호스트에서, 외부망 PC에서 .deb를 받아 USB로 옮깁니다.

```bash
# 외부망 PC
mkdir nvidia-container-debs && cd nvidia-container-debs

# NVIDIA 저장소 등록
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update

# 다운로드만
apt-get install -y --download-only --no-install-recommends \
  -o Dir::Cache::Archives="$(pwd)" \
  nvidia-container-toolkit
```

```bash
# 폐쇄망 서버
cd nvidia-container-debs
sudo dpkg -i ./*.deb
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

## 부록 C — 인스톨러 동작 검증 (테스트 환경)

배포 전에 인스톨러를 안전하게 시뮬레이션하는 두 가지 테스트가 있습니다.

### C-1. Docker 사전 설치 시나리오

```bash
bash scripts/build-installer.sh
bash installer/test/test-airgap.sh
```

`--network none`으로 격리된 docker-in-docker 컨테이너 안에서 인스톨러를 실행합니다. Docker가 이미 깔린 환경 시뮬레이션.

### C-2. 깡통 Ubuntu 24.04 시나리오 (전체 검증)

```bash
bash scripts/build-installer.sh
bash installer/sandbox/up-bare.sh
```

Docker가 전혀 없는 Ubuntu 24.04 컨테이너에 SSH 가능 환경 + 인터넷 차단 (iptables) 으로 띄웁니다. 인스톨러가 .deb 자동 설치까지 끝까지 동작하는지 확인.

```bash
ssh root@localhost -p 2223      # password: hypercube

# 안에서
which docker                     # not installed
ping -c 1 -W 2 google.com        # blocked
sudo /root/hypercube-agent-installer-1.0.0.sh
```

종료:
```bash
docker rm -f hc-airgap-bare hc-airgap-sandbox hc-airgap-test
```

## 참고

- 메인 문서: `CLAUDE.md`, `README.md`
- 프로토콜: `docs/PROTOCOL.md`
- Backend 핸드오프: `docs/backend-handoff.md`
