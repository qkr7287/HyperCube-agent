# Remote Dev 환경 (Agent)

로컬 Windows에서 소스 편집 → Mutagen이 원격 Linux 서버로 실시간 동기화 → 원격의 dev 컨테이너가 tsx watch로 hot-reload.

## 대상 서버

| 서버 | SSH alias | User | Host path | Agent hostname |
|---|---|---|---|---|
| 16 | `hc-dev-16` | root | `/home/agics-ai/ts/agent-dev` | `server_16_dev` |
| 63 | `hc-dev-63` | agics | `/home/agics/ts/agent-dev` | `server_63_dev` |

41번은 prod agent 유지 목적으로 dev 인스턴스를 띄우지 않습니다.

## 사전 준비 (로컬 PC 1회)

1. Mutagen 0.18+ (scoop: `scoop install mutagen`)
2. `~/.ssh/config`에 alias 추가
   ```
   Host hc-dev-16
     HostName 192.168.0.16
     User root
     Port 2022
     IdentityFile ~/.ssh/dcmtool_sync

   Host hc-dev-63
     HostName 192.168.0.63
     User agics
     Port 2022
     IdentityFile ~/.ssh/dcmtool_sync
   ```
3. 공개키가 각 서버의 `authorized_keys`에 등록되어 있을 것. `ssh hc-dev-16 hostname` / `ssh hc-dev-63 hostname`으로 확인.

## 기동

```bash
./scripts/dev-on.sh 63   # 63번 dev 기동
./scripts/dev-on.sh 16   # 16번 dev 기동 (필요 시)
```

스크립트가 하는 일:
1. 원격에 작업 디렉터리 생성
2. Mutagen sync 세션 생성/재개 (`agent-16`, `agent-63`)
3. 초기 동기화 완료 대기
4. 원격에 `.env.dev`가 없으면 `.env.dev.example`에서 복사 + suffix 치환
5. `docker compose -p hypercube-agent-dev -f docker-compose.dev.yml up -d --build`

## 종료

```bash
./scripts/dev-off.sh 63            # 컨테이너 down + Mutagen pause
./scripts/dev-off.sh 63 --terminate # Mutagen 세션까지 정리
```

## 운영 명령

```bash
# 로그 꼬리 보기
ssh hc-dev-63 'cd ~/ts/agent-dev && docker compose -p hypercube-agent-dev -f docker-compose.dev.yml logs -f'

# 세션 상태
mutagen sync list agent-63

# 수동 재동기화
mutagen sync flush agent-63
```

## 주의점

- **컨테이너 이름 충돌 금지**: dev는 `hypercube-agent-dev-<suffix>`, prod는 `hypercube-agent-prod-agent-1`. 같은 compose project name도 쓰지 않음 (`hypercube-agent-dev` vs `hypercube-agent-prod`).
- **node_modules**: 호스트 ↔ 컨테이너 간 동기화하지 않음. 컨테이너 named volume(`agent_node_modules`)에 격리. 호스트에서 `npm install` 할 필요 없음.
- **.env.dev**: Mutagen `--ignore` 목록에 포함되어 로컬 ↔ 원격 자동 동기화 제외. 서버별로 suffix만 다르게 둔다.
- **tsx watch**: 파일 변경 감지 시 자동 재시작. 작은 편집은 수 초 안에 재연결.

## 백엔드 확인

각 dev agent는 `server_<suffix>_dev` hostname으로 `ws://192.168.0.16:3334`에 붙는다. HyperCube Admin UI의 agent 목록에서 `server_63_dev`, `server_16_dev` 표시를 확인한다.

Prod와 dev가 **동시에 같은 백엔드**로 붙되 hostname이 달라 별개 agent로 처리됨.
