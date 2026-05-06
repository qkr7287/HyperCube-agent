#!/bin/bash
# End-to-end air-gap test for the HyperCube Agent installer.
#
# Spins up a minimal Ubuntu 24.04 container (no internet, no pre-installed
# tools) and verifies the installer runs cleanly inside. Uses dind so the
# whole thing is hermetic — image loads happen against a fresh daemon
# inside the test container, never touching the host docker.
set -euo pipefail

# Stop MINGW (Git Bash on Windows) from rewriting POSIX paths like
# /root/installer.sh into Windows host paths before docker.exe sees them.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER_DIR="${REPO_ROOT}/dist-installer"
TEST_NAME="hc-airgap-test"

log()  { printf '\033[1;34m[test]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; cleanup; exit 1; }

cleanup() {
  docker rm -f "$TEST_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Glob safely with spaces in REPO_ROOT.
INSTALLER=""
shopt -s nullglob
for f in "${INSTALLER_DIR}"/hypercube-agent-installer-*.sh; do
  INSTALLER="$f"
done
shopt -u nullglob
[[ -n "$INSTALLER" && -f "$INSTALLER" ]] || \
  fail "No installer found in ${INSTALLER_DIR}. Run scripts/build-installer.sh first."
log "Using installer: $INSTALLER ($(du -h "$INSTALLER" | awk '{print $1}'))"

# docker:dind = a clean Docker-in-Docker host. We run with --network none
# AFTER the daemon has had a chance to come up — but dind needs no internet
# at runtime, only its self-contained binaries that ship in the image.
# Pre-pulling the image first means even the test environment is hermetic.
log "Building test base image (docker:dind + bash + compose plugin)..."
# This is the moral equivalent of an Ubuntu 24.04 server that already has
# Docker Engine + docker compose + bash installed — the prerequisites we
# document in airgap-install.md. Built with internet on the test host so
# the actual installer run can be hermetic.
docker build -t hc-airgap-testbase -f - . >/dev/null <<'DOCKERFILE'
FROM docker:dind
RUN apk add --no-cache bash docker-cli-compose
DOCKERFILE
ok "Test base ready."

cleanup
log "Starting hermetic test box (--network none, dind)..."
# We use `docker cp` instead of -v: bind-mounting a Windows path with
# spaces into a dind sidecar is unreliable across Docker Desktop versions.
# cp is also closer to how a real operator would transfer the file (USB).
docker run -d \
  --name "$TEST_NAME" \
  --privileged \
  --network none \
  hc-airgap-testbase \
  dockerd-entrypoint.sh >/dev/null

log "Copying installer into the box (simulating USB transfer)..."
INSTALLER_HOST="$INSTALLER"
if command -v cygpath >/dev/null 2>&1; then
  INSTALLER_HOST="$(cygpath -w "$INSTALLER")"
fi
docker cp "$INSTALLER_HOST" "${TEST_NAME}:/root/installer.sh"
docker exec "$TEST_NAME" chmod +x /root/installer.sh

log "Waiting for inner docker daemon..."
for i in $(seq 1 30); do
  if docker exec "$TEST_NAME" docker info >/dev/null 2>&1; then
    ok "Inner dockerd up after ${i}s."
    break
  fi
  sleep 1
  [[ $i -eq 30 ]] && fail "Inner docker daemon never came up."
done

log "Verifying network is actually blocked..."
if docker exec "$TEST_NAME" sh -c 'wget -q -T 3 -O - http://1.1.1.1 2>/dev/null'; then
  fail "Container has internet — test is invalid."
fi
ok "Network confirmed blocked."

log "Verifying bash + tar inside box..."
docker exec "$TEST_NAME" bash --version | head -1
docker exec "$TEST_NAME" tar --version | head -1

log "Running installer (non-interactive mode via env vars)..."
# MSYS_NO_PATHCONV=1 prevents MINGW bash on Windows from rewriting
# /root/installer.sh into a Windows-host path before docker exec sees it.
set +e
MSYS_NO_PATHCONV=1 docker exec \
  -e HC_BACKEND_URL="ws://10.99.0.1:8000" \
  -e HC_BACKEND_API_URL="http://10.99.0.1:8000" \
  -e HC_AGENT_HOSTNAME="airgap-test-host" \
  -e HC_GPU_ENABLED="n" \
  -e HC_AUTO_START="n" \
  -e HC_ASSUME_YES="1" \
  "$TEST_NAME" \
  bash /root/installer.sh
RC=$?
set -e
[[ $RC -eq 0 ]] || fail "Installer exited with code $RC"
ok "Installer completed."

log "Verifying state inside the box..."
docker exec "$TEST_NAME" docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -q '^hypercube-agent:' || fail "Image not loaded."
ok "Agent image present in inner docker."

docker exec "$TEST_NAME" test -f /opt/hypercube-agent/.env || fail ".env missing"
docker exec "$TEST_NAME" test -f /opt/hypercube-agent/docker-compose.yml || \
  fail "compose missing"
ok "Config files present."

log "Inspecting generated .env..."
docker exec "$TEST_NAME" cat /opt/hypercube-agent/.env | sed 's/^/    /'

# Agent will fail to register (no backend), but it must at least START.
log "Checking agent container is running..."
sleep 3
if ! docker exec "$TEST_NAME" docker ps --format '{{.Names}}' | grep -qx hypercube-agent; then
  log "  Agent not running — last logs:"
  docker exec "$TEST_NAME" docker logs hypercube-agent 2>&1 | tail -20 | sed 's/^/    /'
  fail "Agent container not running."
fi
ok "Agent container is up."

log "Sampling agent startup logs (expecting register to fail, agent to retry)..."
docker exec "$TEST_NAME" docker logs hypercube-agent 2>&1 | head -10 | sed 's/^/    /'

echo
ok "AIRGAP TEST PASSED"
echo
echo "  - No internet used during install (verified)"
echo "  - Image loaded from embedded tar"
echo "  - .env + compose generated from env-var inputs"
echo "  - Agent container started and is running"
