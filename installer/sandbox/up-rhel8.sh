#!/bin/bash
# Launch a Rocky Linux 8.4 sandbox (RHEL 8.4 clone) with Docker pre-
# installed and the air-gap firewall, then place the slim installer
# (HC_BUNDLE_DOCKER=0 build) at /root/ for the operator to run.
#
# Pairs with airgap-install.md § 부록 A. Use this when the slim
# installer is going to a real RHEL/Rocky/Alma 8 host with Docker
# already on it.
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER_DIR="${REPO_ROOT}/dist-installer"
NAME="hc-airgap-rhel8"
SSH_PORT="${SSH_PORT:-2224}"
IMAGE="hc-airgap-rhel8:latest"

log()  { printf '\033[1;34m[rhel8-sandbox]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

INSTALLER=""
shopt -s nullglob
for f in "${INSTALLER_DIR}"/hypercube-agent-installer-*.sh; do
  INSTALLER="$f"
done
shopt -u nullglob

[[ -n "$INSTALLER" ]] || err "No installer found in ${INSTALLER_DIR}. Build with HC_BUNDLE_DOCKER=0 bash scripts/build-installer.sh"

# Sanity check: warn if the installer looks like the full bundle (~169MB)
# rather than the slim build expected for RHEL.
INSTALLER_BYTES=$(stat -c%s "$INSTALLER" 2>/dev/null || stat -f%z "$INSTALLER")
if (( INSTALLER_BYTES > 100000000 )); then
  log "WARNING: installer is $(du -h "$INSTALLER" | awk '{print $1}') — looks like the full Ubuntu .deb bundle."
  log "         RHEL hosts need the slim build:  HC_BUNDLE_DOCKER=0 bash scripts/build-installer.sh"
fi

log "Using installer: $(basename "$INSTALLER") ($(du -h "$INSTALLER" | awk '{print $1}'))"

log "Building rhel8 sandbox image (${IMAGE}) ..."
SANDBOX_CTX="${REPO_ROOT}/installer/sandbox"
if command -v cygpath >/dev/null 2>&1; then
  SANDBOX_CTX="$(cygpath -w "$SANDBOX_CTX")"
fi
docker build -f "${SANDBOX_CTX}/Dockerfile.rhel8" -t "$IMAGE" "$SANDBOX_CTX" >/dev/null
ok "Image built."

docker rm -f "$NAME" >/dev/null 2>&1 || true

log "Starting RHEL 8 sandbox (privileged, port ${SSH_PORT} -> 22) ..."
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
INSTALLER_NAME="$(basename "$INSTALLER")"
docker cp "$INSTALLER_HOST" "${NAME}:/root/${INSTALLER_NAME}"
docker exec "$NAME" chmod +x "/root/${INSTALLER_NAME}"
ok "Installer placed at /root/${INSTALLER_NAME}"

log "Verifying sandbox state (Docker pre-installed, internet blocked, RHEL 8.4)..."
docker exec "$NAME" sh -c '
  echo "  os:        $(. /etc/os-release && echo \"$PRETTY_NAME\")"
  echo "  docker:    $(docker --version 2>&1)"
  echo "  compose:   $(docker compose version 2>&1)"
  echo "  daemon:    $(docker info --format "{{.ServerVersion}}" 2>&1)"
  echo -n "  internet:  "
  if curl --max-time 3 -sS -o /dev/null https://1.1.1.1 2>/dev/null; then
    echo "OPEN (bad)"
  else
    echo "blocked"
  fi
'

cat <<EOF

==========================================================================
  Rocky 8.4 (= RHEL 8.4) sandbox is up. Docker pre-installed. NO internet.

  SSH in:
    ssh root@localhost -p ${SSH_PORT}
    (password: hypercube)

  Once inside:
    cat /etc/redhat-release
    docker --version
    sudo /root/${INSTALLER_NAME}

  Tear down later:
    docker rm -f ${NAME}
==========================================================================
EOF
