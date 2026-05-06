# Air-Gapped Installation Guide

폐쇄망 서버에 HyperCube Agent를 설치하는 절차입니다. 인터넷이 안 되는 환경에서도 단일 파일(`.sh`)만 USB로 반입하면 끝납니다. **Docker가 안 깔린 깡통 Ubuntu에서도 작동합니다** — 인스톨러가 자체 번들 .deb로 Docker도 같이 설치합니다.

## 이 문서를 어디서부터 읽나요?

- **처음 해보는 사람**: [§ 따라하기](#따라하기--처음부터-끝까지)부터. 명령어 그대로 복붙하면 끝납니다.
- **이미 익숙한 사람**: [§ 0. 흐름 한눈에](#0-흐름-한눈에)부터 순서대로.
- **문제 생긴 사람**: [§ 7. 트러블슈팅](#7-트러블슈팅) + [§ 8. 진단 번들](#8-진단-번들-한-방에-만들기).

---

## 따라하기 — 처음부터 끝까지

Linux를 잘 몰라도 됩니다. **명령어를 그대로 복붙**하시면 됩니다. 각 명령어 아래 **"기대 출력"** 이 적혀 있으니 비슷하게 나오면 다음 단계로 넘어가세요. 다르면 [§ 7](#7-트러블슈팅)이나 [§ 8 진단 번들](#8-진단-번들-한-방에-만들기)을 보고 그 결과를 저(빌드 PC)에게 가져오세요.

### A. 빌드 PC에서 — 인스톨러 만들기 (이미 끝났으면 건너뛰기)

지금 이 가이드를 읽고 있는 PC가 **빌드 PC** (인터넷 가능)입니다. 이미 인스톨러가 만들어져 있으면 § B로 가세요. 없으면:

```powershell
# Windows PowerShell 또는 Git Bash에서
cd "C:\Users\agics\Desktop\workspace\01. git\HyperCube-agent"
git checkout main
git pull
bash scripts/build-installer.sh
```

기대 출력 마지막 줄:
```
[OK] Installer built: ...\dist-installer\hypercube-agent-installer-1.0.0.sh (169M)
```

확인:
```powershell
ls dist-installer/
```
→ `hypercube-agent-installer-1.0.0.sh` 라는 파일이 있어야 합니다.

체크섬도 만들어 두세요 (USB로 옮긴 뒤 깨졌는지 확인용):
```powershell
cd dist-installer
sha256sum hypercube-agent-installer-1.0.0.sh > hypercube-agent-installer-1.0.0.sh.sha256
cat hypercube-agent-installer-1.0.0.sh.sha256
```
기대 출력 (해시값은 매번 다름):
```
abcd1234...ef9876  hypercube-agent-installer-1.0.0.sh
```

### B. USB에 파일 복사

USB 메모리를 빌드 PC에 꽂으면 보통 `D:` 또는 `E:` 같은 드라이브로 잡힙니다. 거기에 파일 두 개를 그냥 끌어다 놓거나 PowerShell로:

```powershell
# 예: USB가 E: 드라이브로 잡힌 경우
cp dist-installer\hypercube-agent-installer-1.0.0.sh E:\
cp dist-installer\hypercube-agent-installer-1.0.0.sh.sha256 E:\
cp docs\airgap-install.md E:\
```

USB 안 내용 확인:
```powershell
ls E:\
```
세 파일이 보여야 합니다:
```
hypercube-agent-installer-1.0.0.sh           169M
hypercube-agent-installer-1.0.0.sh.sha256    64B
airgap-install.md                            ~30KB
```

USB 안전 제거 후 폐쇄망 서버로 가져갑니다.

### C. 폐쇄망 서버에 접속 — SSH

폐쇄망 서버는 보통 모니터·키보드 없이 SSH로만 접속합니다. 다른 PC에서:

```bash
ssh root@<서버IP>
# 또는 비-root 계정이면
ssh <계정>@<서버IP>
sudo -i        # root 권한으로 전환
```

| 만약 이런 게 보이면 | 이렇게 하세요 |
|---|---|
| `password:` | 서버 비밀번호 입력 (관리자에게 받은 것) |
| `Host key verification failed` | `ssh-keygen -R <서버IP>` 후 다시 ssh |
| `Permission denied (publickey)` | 관리자에게 `id_rsa.pub` 등록 요청 |
| `Connection refused` | 서버 SSH 포트 다른 경우. `ssh -p 22022 ...` 처럼 포트 지정 |

### D. USB를 폐쇄망 서버에 꽂고 마운트

서버에 USB를 물리적으로 꽂은 후, SSH 세션에서:

```bash
# 1. USB 장치 이름 찾기
lsblk
```

기대 출력 (예시):
```
NAME    MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS
sda       8:0    0   500G  0 disk
├─sda1    8:1    0   500M  0 part /boot/efi
└─sda2    8:2    0 499.5G  0 part /
sdb       8:16   1  14.9G  0 disk             ← 이게 USB
└─sdb1    8:17   1  14.9G  0 part             ← USB의 파티션
```

`RM=1` (Removable), 본인이 꽂은 사이즈와 비슷한 디스크 = USB. 보통 `sdb1` 또는 `sdc1`. **본인 환경에서 다른 이름이 나올 수 있으니 위 출력 확인 필수.**

```bash
# 2. 마운트 디렉터리 만들고 마운트
sudo mkdir -p /mnt/usb
sudo mount /dev/sdb1 /mnt/usb     # ← sdb1을 본인이 본 이름으로 바꾸세요
```

기대 출력: 아무 메시지 없음 = 성공. (메시지 나오면 보통 에러)

```bash
# 3. 내용 확인
ls -lh /mnt/usb/
```

기대 출력:
```
-rw-r--r-- 1 root root 169M ... hypercube-agent-installer-1.0.0.sh
-rw-r--r-- 1 root root  64B ... hypercube-agent-installer-1.0.0.sh.sha256
-rw-r--r-- 1 root root  30K ... airgap-install.md
```

### E. 무결성 검증 (USB 복사 중 안 깨졌나)

```bash
cd /mnt/usb
sha256sum -c hypercube-agent-installer-1.0.0.sh.sha256
```

기대 출력:
```
hypercube-agent-installer-1.0.0.sh: OK
```

`OK` 안 나오면 USB 복사가 손상된 것 — 다시 복사하세요.

### F. 인스톨러를 서버 디스크에 복사 + 실행 권한

USB는 나중에 빼야 하니, 파일을 서버 본 디스크로 옮깁니다:

```bash
cp /mnt/usb/hypercube-agent-installer-1.0.0.sh /root/
chmod +x /root/hypercube-agent-installer-1.0.0.sh
ls -lh /root/hypercube-agent-installer-1.0.0.sh
```

기대 출력:
```
-rwxr-xr-x 1 root root 169M ... /root/hypercube-agent-installer-1.0.0.sh
```
앞에 `-rwxr-xr-x`처럼 `x`가 보이면 실행 가능 상태.

### G. 인스톨러 실행

```bash
sudo /root/hypercube-agent-installer-1.0.0.sh
```

화면에 다음과 비슷한 출력이 나옵니다:

```
============================================================
  HyperCube Agent installer  (version 1.0.0)
============================================================
[*] Pre-flight checks...
[OK] Pre-flight passed.
[*] Configuration

  Backend WebSocket URL [ws://192.168.0.16:8000]: ▌
```

여기서 입력해야 할 것 (Enter만 치면 `[ ]` 안의 기본값 사용):

| 묻는 것 | 무엇을 입력? |
|---|---|
| `Backend WebSocket URL` | HyperCube Backend 주소. 예: `ws://10.0.1.20:8000` |
| `Backend REST API URL` | 위 ws://를 http://로만 바꾼 값. Enter로 자동값 사용 가능 |
| `Agent hostname` | Enter (서버 호스트명 자동 사용). 또는 임의 이름 |
| `Enable per-container GPU monitoring? (y/n)` | GPU 서버면 `y`, 아니면 `n` |
| `Auto-start on boot via systemd? (y/n)` | `y` (재부팅 후 자동 시작) |
| `Proceed? [Y/n]:` | Enter |

그 후엔 자동 진행. 마지막에 이 줄이 보이면 성공:

```
[OK] Install complete.

  Status : docker ps --filter name=hypercube-agent
  Logs   : docker logs -f hypercube-agent
  ...
  Next: approve the agent in the HyperCube backend admin page.
```

### H. 정상 동작 확인

```bash
# 1. 컨테이너가 떠 있는지
docker ps --filter name=hypercube-agent
```

기대 출력:
```
CONTAINER ID   IMAGE                   STATUS         NAMES
xxxxxxx        hypercube-agent:1.0.0   Up 30 seconds  hypercube-agent
```

`Up xx seconds` 나오면 OK. `Exited` 나오면 § 7.5 참고.

```bash
# 2. 로그에 정상 메시지 보이는지 (5초 정도 보고 Ctrl+C로 빠져나오기)
docker logs -f hypercube-agent
```

기대 출력 (몇 초 안에 이런 줄들이 보여야 함):
```
[INFO] [agent] Starting HyperCube Agent (...)
[INFO] [docker] Docker connection established.
[INFO] [register] Registering with backend...
[INFO] [register] Registration accepted (status: pending)
```

빠져나올 때 `Ctrl+C` (나가도 컨테이너는 계속 실행됨).

### I. Backend에서 승인

신규 Agent는 **`pending` 상태로 등록**되어 있어서, Backend 관리자 페이지에서 **승인(Approve)** 해야 데이터가 전송됩니다.

```
HyperCube 관리자 페이지(웹) → Servers → Pending 탭 → 방금 등록된 호스트명 → 승인
```

승인 후 약 2초 안에 첫 데이터 전송. 로그에서 `Sent NN messages` 같은 줄이 새로 보이면 성공.

### J. USB 정리 + 종료

```bash
# USB 마운트 해제
sudo umount /mnt/usb
# USB 물리적으로 빼기 OK
```

SSH 세션 끝내려면:
```bash
exit
```

**여기까지가 정상 흐름**입니다. 어디선가 막히면 § 7~8 보고 진단 번들을 만들어 빌드 PC로 가져오세요.

---

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

> ### 🚨 막혔을 때 가장 먼저 할 일
> **무엇이 문제인지 모르겠으면 그냥 [§ 8 진단 번들](#8-진단-번들-한-방에-만들기)을 만들어서 빌드 PC로 가져오세요.** 한 줄 명령으로 모든 정보를 자동으로 수집합니다. 그게 가장 빠릅니다.
>
> 아래 케이스별 가이드는 **본인이 직접 해보고 싶을 때**의 참고용입니다. 명령어 의미를 모르면 § 8로 바로 가세요.

---

각 케이스는 같은 구조로 정리되어 있습니다:

- **🖥️ 화면에 보이는 것** — 정확히 이런 메시지가 보이면 이 섹션
- **❓ 무슨 뜻?** — 한 줄 설명
- **🔧 빨리 해보기** — 1~3개 단순 명령
- **🆘 안 되면** — § 8 진단 번들로

---

### 7.1. 인스톨러 시작도 못 함

**🖥️ 화면에 보이는 것:**
```
[X] Missing required command: tar
[X] Missing required command: dpkg
[X] Run as root (sudo ./...)
```
(셋 중 하나)

**❓ 무슨 뜻?** 사전 점검 단계에서 필수 도구가 없거나, 권한이 없다는 뜻.

**🔧 빨리 해보기:**

| 메시지에 있는 단어 | 명령 |
|---|---|
| `tar` 없음 | `sudo apt-get install -y tar` |
| `dpkg` 없음 | 이 서버는 Ubuntu/Debian이 아닌 듯. **빌드 PC로 돌아와** `HC_BUNDLE_DOCKER=0 bash scripts/build-installer.sh`로 슬림 인스톨러 다시 만들고, Docker는 해당 배포판 방식으로 직접 설치 |
| `Run as root` | 명령어 앞에 `sudo` 붙여서 다시: `sudo /root/hypercube-agent-installer-1.0.0.sh` |

**🆘 안 되면:** § 8 진단 번들

---

### 7.2. Docker 설치하다 멈춤

**🖥️ 화면에 보이는 것:**
```
[X] dpkg failed to install bundled .debs after retries.
```

**❓ 무슨 뜻?** 번들된 Docker 패키지(.deb)를 설치하려다가 두 번 시도 후 실패. 보통 **타겟이 Ubuntu 24.04 amd64가 아니거나**, 다른 apt 작업이 동시에 돌고 있거나, 디스크가 가득 찬 경우.

**🔧 빨리 해보기:**
```bash
# 1) Ubuntu 24.04 amd64인지 확인
. /etc/os-release && echo "$VERSION_CODENAME / $(dpkg --print-architecture)"
# 기대: noble / amd64
```
```bash
# 2) 다른 패키지 작업 안 돌고 있는지 확인 (출력 비어 있어야 정상)
pgrep -a dpkg
pgrep -a apt
```
```bash
# 3) 디스크 여유 확인 (Avail 컬럼이 1G 이상이어야 안전)
df -h /var /tmp
```

위 중 **(1)**에서 noble/amd64 안 나오면 → 이 가이드의 인스톨러 적용 대상이 아닙니다. **빌드 PC**로 와서 알려주세요.

**🆘 안 되면:** § 8 진단 번들

---

### 7.3. Docker는 깔렸는데 안 켜짐

**🖥️ 화면에 보이는 것:**
```
[X] Docker daemon never came up. Last log:
...
```

**❓ 무슨 뜻?** Docker 패키지는 설치됐지만 데몬(`dockerd`)이 부팅에 실패. 보통 다른 Docker가 이미 떠 있거나, 권한/소켓 충돌, 또는 커널 모듈 문제.

**🔧 빨리 해보기:**
```bash
# 1) 다른 dockerd가 이미 떠 있는지 (출력 비어 있어야 정상)
pgrep -af dockerd
```
```bash
# 2) systemd 있으면 재시작 시도
sudo systemctl restart docker
sudo systemctl status docker --no-pager -n 20
```
```bash
# 3) 그래도 안 되면 socket 정리 후 재시도
sudo rm -f /var/run/docker.sock
sudo systemctl restart docker
```

**🆘 안 되면:** § 8 진단 번들 — `/tmp/hc-dockerd.log`가 자동 포함됩니다.

---

### 7.4. Docker는 떴는데 이미지 로드 실패

**🖥️ 화면에 보이는 것:**
```
... no space left on device
... permission denied
```

**❓ 무슨 뜻?** 디스크가 부족하거나, `/var/lib/docker` 권한 문제.

**🔧 빨리 해보기:**
```bash
# 1) 디스크 (Avail 1G 이상 필요)
df -h /var/lib/docker
```
```bash
# 2) 디스크가 적으면 docker 캐시 비우기
sudo docker system prune -af
df -h /var/lib/docker
```

**🆘 안 되면:** § 8 진단 번들

---

### 7.5. Agent 컨테이너가 안 뜨거나 즉시 죽음

**🖥️ 화면에 보이는 것:**
```
[X] Agent container did not come up. Check: docker logs hypercube-agent
```
또는 `docker ps`에 잠깐 떴다가 사라짐.

**❓ 무슨 뜻?** Agent가 시작 직후 에러로 종료. .env 설정 문제거나 마운트할 파일이 호스트에 없는 경우.

**🔧 빨리 해보기:**
```bash
# 1) Agent 마지막 로그 — 어떤 에러가 났는지 보여줌
docker logs hypercube-agent --tail 50
```
```bash
# 2) 컨테이너 종료 이유 확인
docker inspect hypercube-agent --format '{{.State.Status}}: {{.State.Error}}'
```
```bash
# 3) compose 파일 문법 검증
cd /opt/hypercube-agent && docker compose config >/dev/null && echo "OK"
```

**🆘 안 되면:** § 8 진단 번들

---

### 7.6. Agent는 떠 있는데 Backend 연결만 안 됨

**🖥️ 화면에 보이는 것:**
```
[INFO] [agent] Starting HyperCube Agent (...)
[INFO] [docker] Docker connection established.
[ERROR] [register] Connection failed: fetch failed. Retrying in 30s...
```
(이게 30초마다 무한 반복)

**❓ 무슨 뜻?** Agent는 정상 기동했지만 Backend(HyperCube 서버)에 못 닿음. 보통 **(a)** Backend URL이 틀렸거나, **(b)** 방화벽이 막고 있거나, **(c)** Backend가 꺼진 상태.

**🔧 빨리 해보기:**
```bash
# 1) .env에 적힌 Backend 주소 확인
grep BACKEND /opt/hypercube-agent/.env
```
```bash
# 2) 호스트에서 직접 Backend에 닿는지 (10초 안에 응답 와야 정상)
source /opt/hypercube-agent/.env
curl -v --max-time 10 "$BACKEND_API_URL/api/agents/"
```
```bash
# 3) ping이라도 닿는지 (Backend host 부분만 추출)
backend_host=$(echo "$BACKEND_API_URL" | sed -E 's|^https?://||; s|[:/].*||')
ping -c 3 -W 2 "$backend_host"
```

**(2)** 가 timeout이면 방화벽·라우팅 문제. **(1)** 의 URL이 틀렸으면 `.env` 수정 후 재시작:
```bash
sudo nano /opt/hypercube-agent/.env       # 또는 본인이 편한 에디터
sudo systemctl restart hypercube-agent
# systemd 없으면
cd /opt/hypercube-agent && sudo docker compose up -d --force-recreate
```

**ℹ️ 헷갈리기 쉬운 정상 상태:** 로그에 `Registration accepted (status: pending)` 만 보이고 그 뒤가 조용하면 **에러가 아닙니다** — Backend 관리자 페이지에서 **승인** 안 한 상태. § 따라하기 § I 참고.

**🆘 안 되면:** § 8 진단 번들

---

### 7.7. GPU 메트릭이 안 잡힘

**🖥️ 화면에 보이는 것 (Agent 로그에서):**
```
[WARN] [gpu-pmon] nvidia-smi unavailable
```
또는
```
[DEBUG] [gpu-pmon] pmon returned empty (idle)
```

**❓ 무슨 뜻?**
- 위쪽: 호스트에 NVIDIA 드라이버 또는 `nvidia-container-toolkit`이 안 깔려 있음.
- 아래쪽: **정상**. RTX 계열은 GPU 부하가 없을 때 측정을 차단합니다. 부하 생기면 자동 측정.

**🔧 빨리 해보기:**
```bash
# 1) 호스트에 nvidia-smi 동작하나
nvidia-smi
```
```bash
# 2) 컨테이너 안에서도 보이나
docker exec hypercube-agent nvidia-smi 2>&1 | head -5
```

`(1)`이 안 되면 → NVIDIA 드라이버가 호스트에 없습니다. (Agent가 깔지 못함 — 부록 B 참조)
`(1)`은 되는데 `(2)`만 안 되면 → `nvidia-container-toolkit` 누락. 부록 B로.

**🆘 안 되면:** § 8 진단 번들

---

### 7.8. "payload marker not found"

**🖥️ 화면에 보이는 것:**
```
[X] Payload marker not found — is this a built installer?
```

**❓ 무슨 뜻?** 인스톨러 파일(.sh)이 손상됐어요. USB 복사가 깨졌거나 안티바이러스가 끝부분을 잘라먹었거나.

**🔧 빨리 해보기:**

폐쇄망 서버에서:
```bash
sha256sum /root/hypercube-agent-installer-1.0.0.sh
```

**빌드 PC**(인스톨러 만든 곳)에서:
```powershell
sha256sum dist-installer/hypercube-agent-installer-1.0.0.sh
```

두 해시가 다르면 → USB 복사 다시 (반드시 바이너리 모드, FTP면 `binary` 명령). 같으면 빌드 자체가 깨진 것 → 빌드 PC에서 `bash scripts/build-installer.sh` 다시.

**🆘 안 되면:** § 8 진단 번들

---

### 7.9. 재부팅 후 Agent 자동 시작 안 됨

**🖥️ 화면에 보이는 것:** 재부팅 후 `docker ps`에 hypercube-agent가 없음.

**❓ 무슨 뜻?** systemd가 부팅 시 Agent를 안 띄움. 보통 systemd 등록을 안 했거나, Docker 데몬보다 먼저 시도됐거나.

**🔧 빨리 해보기:**
```bash
# 1) 자동 시작 등록 상태 확인 — 'enabled' 나와야 정상
systemctl is-enabled hypercube-agent
```
```bash
# 2) 'disabled'면 등록
sudo systemctl enable hypercube-agent
sudo systemctl start hypercube-agent
```
```bash
# 3) 시작 실패 이유 확인
sudo systemctl status hypercube-agent --no-pager -n 30
sudo journalctl -u hypercube-agent -n 50 --no-pager
```

**🆘 안 되면:** § 8 진단 번들 — systemd journal이 자동 포함됩니다.

---

## 8. 진단 번들 한 방에 만들기

**막혔을 때 본인이 할 일은 딱 두 가지:**
1. 아래 명령 한 줄 복붙해서 실행 → 작은 .tar.gz 파일 하나 생김
2. USB에 넣어서 빌드 PC로 가져오기

그러면 빌드 PC에서 분석해서 다음 인스톨러로 고쳐서 보내드릴 수 있습니다.

### 어떻게 실행?

폐쇄망 서버에 SSH 들어간 상태에서, 아래 블록 **전체를 그대로 복붙**해서 Enter:

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

### 끝나면 마지막에 이런 메시지가 보입니다

```
===============================================================
DONE. Send this file to the build PC:
-rw-r--r-- 1 root root 47K Aug 14 10:32 /tmp/hc-diag-bundle-20260814-103245.tar.gz
===============================================================
```

### USB로 가져오기

```bash
# USB가 /mnt/usb에 마운트돼 있는 상태에서
sudo cp /tmp/hc-diag-bundle-*.tar.gz /mnt/usb/
sudo umount /mnt/usb
```

USB 빼서 빌드 PC에 꽂은 뒤, 그 .tar.gz 파일을 알려주세요 (메일·메신저 등으로 보내거나, 빌드 PC에서 직접 읽어서 분석).

### 함께 알려주면 좋은 것

진단 번들과 함께 다음 정보를 글로 전달해 주세요:

1. **무엇을 하다가 막혔는지**
   - 예: "인스톨러 첫 실행에서", "재부팅 후 자동 시작이 안 됐는데", "1주일 잘 돌다가 갑자기"
2. **마지막에 본 에러 메시지** 한 줄 (사진 찍어 보내도 OK)
3. **대략 언제 발생** (오늘 14:30 같이 — 로그 시간대 매칭에 도움)
4. **어디까지는 됐는지** (Pre-flight는 통과했는지, Docker는 깔렸는지 등)

### .tar.gz 안에 뭐가 들어 있나? (참고용)

| 파일 | 무엇 |
|---|---|
| `system.txt` | OS 정보 + Docker 상태 + 컨테이너 목록 + 마운트 + 디스크 + 네트워크 |
| `agent.log` | Agent 컨테이너 마지막 500줄 로그 |
| `journal-docker.log` | systemd가 본 Docker 로그 |
| `journal-agent.log` | systemd가 본 Agent 로그 |
| `dpkg-pass1.log`, `dpkg-pass2.log`, `dpkg-configure.log` | Docker .deb 설치 시도 흔적 |
| `hc-dockerd.log` | 인스톨러가 띄운 dockerd의 부팅 로그 |
| `backend-reach.txt` | 호스트에서 Backend 실제로 닿는지 테스트 |

비밀번호·토큰 같은 민감 정보는 자동 포함되지 않게 만들어졌습니다 (`.env`에서 `BACKEND/AGENT_HOSTNAME/GPU` 라인만 추출).

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
