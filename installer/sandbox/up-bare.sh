#!/bin/bash
# Launch a "bare metal" Ubuntu 24.04 sandbox: no Docker, no compose plugin,
# no curl, no certificates. This is the most adversarial environment for
# the air-gap installer. If it works here, it works anywhere.
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER_DIR="${REPO_ROOT}/dist-installer"
NAME="hc-airgap-bare"
SSH_PORT="${SSH_PORT:-2223}"
IMAGE="hc-airgap-bare:latest"

log()  { printf '\033[1;34m[bare-sandbox]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

INSTALLER=""
shopt -s nullglob
for f in "${INSTALLER_DIR}"/hypercube-agent-installer-*.sh; do
  INSTALLER="$f"
done
shopt -u nullglob

[[ -n "$INSTALLER" ]] || err "No installer found. Run: bash scripts/build-installer.sh"

log "Using installer: $(basename "$INSTALLER") ($(du -h "$INSTALLER" | awk '{print $1}'))"

log "Building bare sandbox image (${IMAGE}) ..."
SANDBOX_CTX="${REPO_ROOT}/installer/sandbox"
if command -v cygpath >/dev/null 2>&1; then
  SANDBOX_CTX="$(cygpath -w "$SANDBOX_CTX")"
fi
docker build -f "${SANDBOX_CTX}/Dockerfile.bare" -t "$IMAGE" "$SANDBOX_CTX" >/dev/null
ok "Image built."

docker rm -f "$NAME" >/dev/null 2>&1 || true

log "Starting bare sandbox (privileged, port ${SSH_PORT} -> 22) ..."
docker run -d \
  --name "$NAME" \
  --privileged \
  -p "${SSH_PORT}:22" \
  "$IMAGE" >/dev/null

log "Waiting for sshd ..."
for i in $(seq 1 30); do
  if docker exec "$NAME" pgrep -x sshd >/dev/null 2>&1; then
    ok "sshd up after ${i}s."
    break
  fi
  sleep 1
  [[ $i -eq 30 ]] && err "sshd never started. Logs: docker logs $NAME"
done

log "Copying installer into /root/ ..."
INSTALLER_HOST="$INSTALLER"
if command -v cygpath >/dev/null 2>&1; then
  INSTALLER_HOST="$(cygpath -w "$INSTALLER")"
fi
docker cp "$INSTALLER_HOST" "${NAME}:/root/$(basename "$INSTALLER")"
docker exec "$NAME" chmod +x "/root/$(basename "$INSTALLER")"
ok "Installer placed at /root/$(basename "$INSTALLER")"

log "Verifying sandbox state (no docker, public internet blocked)..."
docker exec "$NAME" sh -c '
  echo "  docker:  $(command -v docker || echo NOT INSTALLED)"
  echo "  compose: $(docker compose version 2>/dev/null || echo NOT INSTALLED)"
  echo -n "  internet to 1.1.1.1: "
  if curl --max-time 3 -sS -o /dev/null https://1.1.1.1 2>/dev/null; then
    echo "REACHABLE — bad"
  else
    echo "blocked"
  fi
'

cat <<EOF

==========================================================================
  Bare Ubuntu 24.04 sandbox is up. NO Docker. NO compose. NO internet.

  SSH in:
    ssh root@localhost -p ${SSH_PORT}
    (password: hypercube)

  Once inside:
    which docker                                 # not installed
    sudo /root/$(basename "$INSTALLER")          # installer auto-handles it

  Tear down later:
    docker rm -f ${NAME}
==========================================================================
EOF
