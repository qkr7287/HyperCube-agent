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

각 케이스마다 **(1) 보이는 증상**, **(2) 즉시 시도**, **(3) 안 되면 가져올 정보** 순서로 정리했습니다. (3)의 명령은 그대로 복붙해서 출력 파일을 만든 뒤, **§ 8의 진단 번들**과 함께 빌드 PC로 가져오세요.

### 7.1. 인스톨러 시작 즉시 실패 (pre-flight)

**증상:**
```
[X] Missing required command: tar         # 매우 드묾
[X] Missing required command: dpkg        # RHEL/Rocky 등 non-Debian
[X] Run as root (sudo ./...)              # sudo 없이 실행
```

**즉시:**
- `tar`: `sudo apt-get install -y tar`
- `dpkg`: 호스트가 Ubuntu/Debian이 아닙니다. `HC_BUNDLE_DOCKER=0`로 빌드한 슬림 인스톨러로 재배포하고, Docker는 배포판 방식으로 사전 설치
- `Run as root`: 앞에 `sudo` 붙여 다시 실행

**가져올 정보 (해결 안 될 때):**
```bash
{
  echo "=== uname / os-release ==="
  uname -a
  cat /etc/os-release
  echo "=== whoami / id ==="
  whoami; id
  echo "=== installer file ==="
  ls -lh /path/to/hypercube-agent-installer-*.sh
  sha256sum /path/to/hypercube-agent-installer-*.sh
} | tee /tmp/hc-diag-preflight.txt
```

---

### 7.2. Docker .deb 설치 실패

**증상:**
```
[X] dpkg failed to install bundled .debs after retries.
```

**즉시:**
1. 타겟이 진짜 Ubuntu 24.04 amd64인지 확인:
   ```bash
   . /etc/os-release && echo "${VERSION_CODENAME} / $(dpkg --print-architecture)"
   # 기대: noble / amd64
   ```
2. 다른 dpkg 작업이 진행 중이지 않은지: `pgrep -a dpkg && pgrep -a apt`
3. 디스크 여유: `df -h /var /tmp`

**가져올 정보:**
```bash
{
  echo "=== os ==="
  cat /etc/os-release
  dpkg --print-architecture
  echo "=== dpkg pass logs (installer가 남긴 것) ==="
  for f in /tmp/dpkg-pass1.log /tmp/dpkg-pass2.log /tmp/dpkg-configure.log; do
    echo "--- $f ---"
    cat "$f" 2>/dev/null || echo "(missing)"
  done
  echo "=== 현재 설치된 docker 관련 패키지 ==="
  dpkg -l | grep -iE 'docker|containerd|runc' || echo "(none)"
  echo "=== bundled deb 목록 ==="
  ls /tmp/hc-payload.*/docker-debs/ 2>/dev/null || echo "(payload already cleaned up)"
  echo "=== disk ==="
  df -h /var /tmp /
} | tee /tmp/hc-diag-deb.txt
```

---

### 7.3. dockerd가 안 뜸

**증상:**
```
[X] Docker daemon never came up. Last log:
...
```

**즉시:**
1. 이미 떠 있는 다른 dockerd 있는지: `pgrep -af dockerd`
2. (systemd 있을 때) `sudo systemctl status docker -n 50`
3. socket 충돌: `ls -la /var/run/docker.sock` 권한·소유자 확인

**가져올 정보:**
```bash
{
  echo "=== dockerd log (installer가 띄운 것) ==="
  cat /tmp/hc-dockerd.log 2>/dev/null || echo "(missing)"
  echo "=== systemd journal (있다면) ==="
  command -v journalctl >/dev/null && journalctl -u docker -n 100 --no-pager 2>/dev/null
  echo "=== systemctl status ==="
  command -v systemctl >/dev/null && systemctl status docker -n 30 --no-pager 2>/dev/null
  echo "=== dockerd processes ==="
  pgrep -af dockerd || echo "(no dockerd running)"
  ps -eo pid,ppid,cmd | grep -E 'docker|containerd' | grep -v grep
  echo "=== socket / lib ==="
  ls -la /var/run/docker.sock 2>/dev/null
  ls -la /var/lib/docker/ 2>/dev/null | head -20
  echo "=== kernel ==="
  uname -r
  dmesg 2>/dev/null | tail -30
  echo "=== cgroup support ==="
  ls /sys/fs/cgroup/ | head
} | tee /tmp/hc-diag-dockerd.txt
```

---

### 7.4. 이미지 로드 실패

**증상:**
```
[X] ... docker load: ... no space left on device
[X] ... open /var/lib/docker/...: permission denied
```

**즉시:**
- 디스크 여유: `df -h /var/lib/docker`
- 권한: `ls -la /var/lib/docker`

**가져올 정보:**
```bash
{
  echo "=== disk ==="
  df -h /var/lib/docker /var /
  echo "=== docker info ==="
  docker info 2>&1 | head -50
  echo "=== docker images (현재) ==="
  docker images 2>&1
  echo "=== payload .tar 크기 ==="
  ls -la /tmp/hc-payload.*/agent-image.tar 2>/dev/null || echo "(payload cleaned up)"
} | tee /tmp/hc-diag-image.txt
```

---

### 7.5. 컨테이너가 안 뜸 / 즉시 종료

**증상:**
```
[X] Agent container did not come up. Check: docker logs hypercube-agent
```
또는 `docker ps`에 잠깐 보였다가 사라짐.

**즉시:**
1. `docker logs hypercube-agent --tail 100` — 컨테이너 안 에러
2. `docker inspect hypercube-agent --format '{{.State.Status}}: {{.State.Error}}'`
3. compose 파일 검증: `cd /opt/hypercube-agent && docker compose config`

**가져올 정보:**
```bash
{
  echo "=== container state ==="
  docker ps -a --filter name=hypercube-agent
  docker inspect hypercube-agent 2>&1 | head -100
  echo "=== container logs ==="
  docker logs hypercube-agent --tail 200 2>&1
  echo "=== compose config ==="
  cat /opt/hypercube-agent/docker-compose.yml
  cd /opt/hypercube-agent && docker compose config 2>&1
  echo "=== env (sanitized — BACKEND/HOSTNAME만 표시) ==="
  grep -E '^(BACKEND|AGENT_HOSTNAME|GPU)' /opt/hypercube-agent/.env
  echo "=== required mount points ==="
  ls -la /var/run/docker.sock /var/run/utmp /etc/hostname 2>&1
  ls -la /proc | head -5
} | tee /tmp/hc-diag-container.txt
```

---

### 7.6. Agent는 떠 있는데 Backend 연결 실패만 반복

**증상:**
```
[INFO] [agent] Starting HyperCube Agent (...)
[INFO] [docker] Docker connection established.
[ERROR] [register] Connection failed: fetch failed. Retrying in 30s...
```
(이게 무한 반복)

**즉시:**
1. `.env`의 backend URL 확인: `grep BACKEND /opt/hypercube-agent/.env`
2. 호스트에서 직접 닿는지: `curl -v --max-time 5 $BACKEND_API_URL/api/agents/`
3. Backend 살아 있나: 다른 Agent가 정상 동작 중이면 Backend OK → 이 호스트만의 네트워크/방화벽 이슈

**가져올 정보:**
```bash
{
  echo "=== .env 설정 ==="
  grep -E '^(BACKEND|AGENT_HOSTNAME)' /opt/hypercube-agent/.env
  echo "=== 호스트→Backend 직접 접속 ==="
  source /opt/hypercube-agent/.env 2>/dev/null
  echo "URL: $BACKEND_API_URL"
  curl -v --max-time 5 "$BACKEND_API_URL/api/agents/" 2>&1 | head -40
  echo "=== DNS / 라우팅 ==="
  ip route
  cat /etc/resolv.conf 2>/dev/null
  echo "=== ping ==="
  backend_host=$(echo "$BACKEND_API_URL" | sed -E 's|^https?://||; s|[:/].*||')
  ping -c 3 -W 2 "$backend_host" 2>&1 | tail -5
  echo "=== agent 측 로그 ==="
  docker logs hypercube-agent --tail 50 2>&1
} | tee /tmp/hc-diag-backend.txt
```

> **사이드 노트**: 등록 후엔 Backend 관리자가 **승인(approve)** 해야 데이터가 흐릅니다. 위 로그에 `Registration accepted (status: pending)`만 보이고 그 뒤로 아무 것도 없으면 **에러가 아니라 승인 대기 상태** — Backend 관리자 페이지에서 처리하세요.

---

### 7.7. GPU 메트릭이 안 잡힘

**증상:**
```
[WARN] [gpu-pmon] nvidia-smi unavailable
[DEBUG] [gpu-pmon] pmon returned empty (idle)
```

**즉시:**
- 첫 번째: 호스트에 NVIDIA 드라이버 + `nvidia-container-toolkit`이 깔려 있어야 합니다 (Agent는 깔지 못함). `nvidia-smi` 호스트에서 동작하는지 확인.
- 두 번째: **정상**. RTX 계열은 GPU idle 시 sm 측정을 차단. 부하가 발생하면 자동으로 측정됨.

**가져올 정보 (드라이버는 있는데도 안 잡힐 때):**
```bash
{
  echo "=== host nvidia-smi ==="
  nvidia-smi 2>&1
  echo "=== nvidia-container-toolkit ==="
  dpkg -l | grep nvidia-container 2>/dev/null
  command -v nvidia-ctk && nvidia-ctk --version
  echo "=== docker daemon.json ==="
  cat /etc/docker/daemon.json 2>/dev/null
  echo "=== container 안에서 nvidia-smi 보이나 ==="
  docker exec hypercube-agent nvidia-smi 2>&1 | head -20
  echo "=== gpu 관련 agent log ==="
  docker logs hypercube-agent 2>&1 | grep -iE 'gpu|nvidia|pmon|dcgm' | tail -30
} | tee /tmp/hc-diag-gpu.txt
```

---

### 7.8. 인스톨러 "payload marker not found"

**증상:**
```
[X] Payload marker not found — is this a built installer?
```

**원인 후보:**
1. 빌드가 안 끝난 / 깨진 .sh 받음
2. USB 복사 중 텍스트 모드 변환 (예: scp 옵션, FTP ASCII 모드)
3. 안티바이러스가 .sh 끝부분 잘라먹음

**즉시:**
```bash
sha256sum /path/to/hypercube-agent-installer-*.sh
# 빌드 PC의 sha256sum과 비교
```

빌드 PC에서:
```bash
sha256sum dist-installer/hypercube-agent-installer-*.sh
```

두 해시 다르면 USB 재복사 (반드시 바이너리 모드).

---

### 7.9. systemd 등록은 됐는데 자동 시작 안 됨

**증상:** 재부팅 후 `docker ps`에 hypercube-agent 없음.

**즉시:**
```bash
systemctl is-enabled hypercube-agent   # → enabled 여야 함
systemctl status hypercube-agent
journalctl -u hypercube-agent -n 50 --no-pager
```

**가져올 정보:**
```bash
{
  systemctl status hypercube-agent --no-pager 2>&1
  systemctl status docker --no-pager 2>&1
  journalctl -u hypercube-agent -n 100 --no-pager 2>&1
  cat /etc/systemd/system/hypercube-agent.service
} | tee /tmp/hc-diag-systemd.txt
```

---

## 8. 진단 번들 한 방에 만들기

문제 종류를 모르겠을 때, 또는 빌드 PC로 가져와서 한 번에 분석하고 싶을 때 — 아래 스니펫을 **그대로 복붙**해서 실행하면 `/tmp/hc-diag-bundle-*.tar.gz`이 생깁니다. 이 파일 한 개를 USB로 가져오시면 됩니다.

```bash
sudo bash -c '
TS=$(date +%Y%m%d-%H%M%S)
OUT=/tmp/hc-diag-bundle-$TS
mkdir -p "$OUT"

{
  echo "=== os ==="
  uname -a
  cat /etc/os-release
  dpkg --print-architecture 2>/dev/null
  date
  uptime
  echo
  echo "=== docker / compose ==="
  docker --version 2>&1
  docker compose version 2>&1
  docker info 2>&1 | head -60
  echo
  echo "=== running containers ==="
  docker ps -a 2>&1
  echo
  echo "=== images ==="
  docker images 2>&1
  echo
  echo "=== installed docker pkgs ==="
  dpkg -l 2>/dev/null | grep -iE "docker|containerd|runc"
  echo
  echo "=== systemd ==="
  command -v systemctl >/dev/null && {
    systemctl status docker --no-pager -n 30 2>&1
    systemctl status hypercube-agent --no-pager -n 30 2>&1
  }
  echo
  echo "=== /opt/hypercube-agent ==="
  ls -la /opt/hypercube-agent/ 2>&1
  cat /opt/hypercube-agent/docker-compose.yml 2>&1
  grep -E "^(BACKEND|AGENT_HOSTNAME|GPU)" /opt/hypercube-agent/.env 2>&1
  echo
  echo "=== mount points required ==="
  ls -la /var/run/docker.sock /var/run/utmp /etc/hostname 2>&1
  echo
  echo "=== disk ==="
  df -h
  echo
  echo "=== network ==="
  ip addr
  ip route
  cat /etc/resolv.conf 2>/dev/null
} > "$OUT/system.txt" 2>&1

# Logs
docker logs hypercube-agent --tail 500 > "$OUT/agent.log" 2>&1 || echo "(agent not running)" > "$OUT/agent.log"
command -v journalctl >/dev/null && journalctl -u docker -n 300 --no-pager > "$OUT/journal-docker.log" 2>&1
command -v journalctl >/dev/null && journalctl -u hypercube-agent -n 300 --no-pager > "$OUT/journal-agent.log" 2>&1

# Installer leftovers
for f in /tmp/dpkg-pass1.log /tmp/dpkg-pass2.log /tmp/dpkg-configure.log /tmp/hc-dockerd.log; do
  [[ -f "$f" ]] && cp "$f" "$OUT/"
done

# Backend reachability test
source /opt/hypercube-agent/.env 2>/dev/null
[[ -n "${BACKEND_API_URL:-}" ]] && {
  echo "=== curl $BACKEND_API_URL/api/agents/ ==="
  curl -v --max-time 5 "$BACKEND_API_URL/api/agents/" 2>&1
  host=$(echo "$BACKEND_API_URL" | sed -E "s|^https?://||; s|[:/].*||")
  echo
  echo "=== ping $host ==="
  ping -c 3 -W 2 "$host" 2>&1
} > "$OUT/backend-reach.txt" 2>&1

tar czf "${OUT}.tar.gz" -C /tmp "$(basename $OUT)"
rm -rf "$OUT"
echo "==============================================================="
echo "DONE. Send this file to the build PC:"
ls -lh "${OUT}.tar.gz"
echo "==============================================================="
'
```

산출물 예: `/tmp/hc-diag-bundle-20260507-103245.tar.gz` (보통 < 1MB).

USB로 빌드 PC에 가져와 `tar tzf hc-diag-bundle-*.tar.gz`로 내용 확인 후 분석하면 됩니다.

### 보낼 때 같이 알려주면 좋은 것
- **무엇을 하다가 막혔는지**: "인스톨러 첫 실행", "재부팅 후", "수일 운영하다가" 등
- **마지막에 본 에러 메시지** 한 줄
- **언제 발생** (대략적인 시간 — 로그 정렬에 도움)

## 9. 안전 모드 — 인스톨러 없이 직접 손보기

자동 인스톨러가 어떤 이유로든 실패하고 빠른 복구가 필요할 때, 같은 일을 손으로 할 수 있습니다.

```bash
# 1. 인스톨러 안의 payload만 추출 (이미지 + .deb)
LINE=$(grep -an '^__PAYLOAD_BELOW__$' hypercube-agent-installer-1.0.0.sh | head -1 | cut -d: -f1)
mkdir -p /tmp/hc-manual
tail -n +$((LINE+1)) hypercube-agent-installer-1.0.0.sh | tar x -C /tmp/hc-manual

# 2. (필요 시) Docker 수동 설치
sudo dpkg -i /tmp/hc-manual/docker-debs/*.deb
sudo dpkg --configure -a
sudo dpkg -i /tmp/hc-manual/docker-debs/*.deb   # 2-pass
sudo systemctl enable --now docker

# 3. Agent 이미지 로드
sudo docker load -i /tmp/hc-manual/agent-image.tar

# 4. /opt/hypercube-agent 직접 작성 (인스톨러가 만들었던 것과 동일)
sudo mkdir -p /opt/hypercube-agent
sudo tee /opt/hypercube-agent/.env > /dev/null <<EOF
BACKEND_URL=ws://10.0.1.20:8000
BACKEND_API_URL=http://10.0.1.20:8000
AGENT_HOSTNAME=$(hostname)
COLLECT_INTERVAL=2000
DOCKER_SOCKET=/var/run/docker.sock
HOST_PROC_PATH=/host/proc
GPU_PER_CONTAINER_ENABLED=true
DOCKER_GID=$(getent group docker | cut -d: -f3)
EOF

sudo tee /opt/hypercube-agent/docker-compose.yml > /dev/null <<'EOF'
services:
  agent:
    image: hypercube-agent:1.0.0
    container_name: hypercube-agent
    restart: unless-stopped
    env_file: .env
    network_mode: host
    privileged: true
    pid: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /proc:/host/proc:ro
      - /var/run/utmp:/var/run/utmp:ro
      - /etc/hostname:/host/etc/hostname:ro
    group_add: ["${DOCKER_GID:-999}"]
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "10"
EOF

# 5. 기동
cd /opt/hypercube-agent && sudo docker compose up -d
sudo docker logs -f hypercube-agent
```

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
