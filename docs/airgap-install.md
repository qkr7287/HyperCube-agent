# Air-Gapped Installation Guide

폐쇄망 서버에 HyperCube Agent를 설치하는 절차입니다. 인터넷이 안 되는 환경에서도 단일 파일(`.sh`)만 USB로 반입하면 끝납니다.

## 0. 흐름 한눈에

```
[외부망 빌드 PC]                  [USB]                [폐쇄망 서버]
  build-installer.sh
   ├ docker build
   ├ docker save        ──→  installer.sh  ──→  sudo ./installer.sh
   └ self-extract 패킹            (84MB)         (인터랙티브 입력)
```

## 1. 폐쇄망 서버 사전 조건

설치 전에 폐쇄망 서버(예: Ubuntu 24.04 LTS)에 다음이 깔려 있어야 합니다.

| 도구 | 확인 명령 | 비고 |
|---|---|---|
| `docker` | `docker --version` | Engine 24.0+ 권장 |
| `docker compose` 플러그인 | `docker compose version` | v2 |
| `bash` | `bash --version` | 5.x |
| `tar` | `tar --version` | Docker가 의존하므로 사실상 보장 |
| `systemd` | `systemctl --version` | 부팅 시 자동 시작 원할 때만 |

`docker` 자체가 폐쇄망에 없다면 § 5의 "Docker 오프라인 설치" 부록을 먼저 진행하세요.

권한:
- `root` 또는 `sudo` 필요
- GPU 모니터링이 목적이면 NVIDIA 드라이버 + `nvidia-container-toolkit`이 호스트에 사전 설치돼 있어야 합니다 (드라이버는 Agent가 설치할 수 없음).

## 2. 빌드 PC (외부망)에서 인스톨러 만들기

```bash
git clone https://github.com/qkr7287/hypercube-agent.git
cd hypercube-agent

# 단일 파일 인스톨러 빌드
bash scripts/build-installer.sh

# 산출물
ls dist-installer/
# → hypercube-agent-installer-1.0.0.sh   (~84MB)
```

이 한 파일에 다음이 모두 들어 있습니다:
- node:20-alpine 베이스 + Agent 코드 + node_modules + native bindings
- 설치 로직(자기 압축 해제 + .env 생성 + systemd 등록)

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
[X] Missing required command: docker
```
→ Docker Engine을 먼저 설치하세요 (§ 부록).

```
[X] Docker daemon is not reachable.
```
→ `sudo systemctl start docker`

```
[X] Docker Compose plugin not found.
```
→ Ubuntu: `sudo apt install -y docker-compose-plugin` (오프라인은 § 부록).

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

## 부록 — Docker Engine 오프라인 설치 (Ubuntu 24.04)

폐쇄망 서버에 Docker가 없는 경우, 외부망에서 .deb 받아 USB로 옮깁니다.

### 외부망 PC에서 .deb 다운

```bash
mkdir docker-debs && cd docker-debs

# Docker 공식 저장소 추가
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu noble stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update

# 패키지 + 의존성 다운로드만
apt-get download \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
# 의존성까지 한 방에:
#   apt-get install -y --download-only -o Dir::Cache::Archives="$(pwd)" \
#     docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

### 폐쇄망 서버에서 설치

```bash
cd docker-debs
sudo dpkg -i ./*.deb
sudo systemctl enable --now docker

# 확인
docker --version
docker compose version
```

### NVIDIA Container Toolkit 오프라인 설치 (GPU 호스트만)

GPU 모니터링이 필요한 호스트에서, 외부망 PC에서 `apt-get download nvidia-container-toolkit nvidia-container-runtime` 으로 .deb를 받아 동일 절차로 옮기고 `dpkg -i`. 그 다음:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

## 부록 — 인스톨러 동작 검증 (테스트 환경)

배포 전에 인스톨러 자체를 폐쇄망 환경에서 시뮬레이션하려면:

```bash
# 빌드 PC에서
bash scripts/build-installer.sh
bash installer/test/test-airgap.sh
```

이 테스트는 `--network none`으로 격리된 docker-in-docker 컨테이너 안에서 인스톨러를 실제로 실행해, 인터넷 없이 정상 동작하는지를 끝까지 검증합니다.

## 참고

- 메인 문서: `CLAUDE.md`, `README.md`
- 프로토콜: `docs/PROTOCOL.md`
- Backend 핸드오프: `docs/backend-handoff.md`
