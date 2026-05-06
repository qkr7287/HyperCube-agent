#!/bin/bash
# Launch a throwaway Ubuntu 24.04 sandbox with sshd + dockerd, then drop
# the latest built installer into /root/ so you can SSH in and rehearse
# the air-gap install manually.
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER_DIR="${REPO_ROOT}/dist-installer"
NAME="hc-airgap-sandbox"
SSH_PORT="${SSH_PORT:-2222}"
IMAGE="hc-airgap-sandbox:latest"

log()  { printf '\033[1;34m[sandbox]\033[0m %s\n' "$*"; }
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

log "Building sandbox image (${IMAGE}) ..."
SANDBOX_CTX="${REPO_ROOT}/installer/sandbox"
if command -v cygpath >/dev/null 2>&1; then
  SANDBOX_CTX="$(cygpath -w "$SANDBOX_CTX")"
fi
docker build -t "$IMAGE" "$SANDBOX_CTX" >/dev/null
ok "Image built."

# Wipe any prior sandbox so re-running this script is idempotent.
docker rm -f "$NAME" >/dev/null 2>&1 || true

log "Starting sandbox container (privileged, port ${SSH_PORT} -> 22) ..."
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

cat <<EOF

==========================================================================
  Sandbox is up.

  SSH in:
    ssh root@localhost -p ${SSH_PORT}
    (password: hypercube)

  Once inside:
    ls -lh /root/                                # see the installer
    sudo /root/$(basename "$INSTALLER")          # run it

  Tear down later:
    docker rm -f ${NAME}

  Inspect from outside without ssh:
    docker exec -it ${NAME} bash
==========================================================================
EOF
