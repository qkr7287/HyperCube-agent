#!/bin/bash
# HyperCube Agent self-extracting installer.
#
# Layout: this script + a tar payload are concatenated by
# scripts/build-installer.sh. The marker line below tells us where the
# payload starts so we can `tail -c +N | tar x` it back out.
#
# Payload contents:
#   agent-image.tar            (always)
#   docker-debs/*.deb          (optional — Ubuntu 24.04 amd64 Docker bundle)
set -euo pipefail

VERSION="__VERSION__"
IMAGE_TAG="hypercube-agent:${VERSION}"
INSTALL_DIR="/opt/hypercube-agent"
ENV_PATH="${INSTALL_DIR}/.env"
COMPOSE_PATH="${INSTALL_DIR}/docker-compose.yml"
SERVICE_NAME="hypercube-agent"
PAYLOAD_MARKER="__PAYLOAD_BELOW__"

PAYLOAD_DIR=""
USE_SYSTEMD=0

# ----- helpers ---------------------------------------------------------------
log()  { printf '\033[1;34m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[X]\033[0m %s\n' "$*" >&2; }

cleanup() {
  [[ -n "$PAYLOAD_DIR" && -d "$PAYLOAD_DIR" ]] && rm -rf "$PAYLOAD_DIR"
}
trap cleanup EXIT

require_root() {
  if [[ $EUID -ne 0 ]]; then
    err "Run as root (sudo ./$(basename "$0"))."
    exit 1
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    [[ -n "${2:-}" ]] && echo "    $2" >&2
    exit 1
  fi
}

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# ----- pre-flight ------------------------------------------------------------
preflight() {
  log "Pre-flight checks..."
  # Docker + dpkg are checked LATER. dpkg is only needed when we actually
  # have to install bundled .debs; a host that already has Docker can run
  # this installer on any distro (Alpine, RHEL, etc.).
  require_cmd tar    "Install with: apt-get install -y tar"
  require_cmd awk
  require_cmd sed

  if has_cmd systemctl && [[ -d /run/systemd/system ]]; then
    USE_SYSTEMD=1
  else
    USE_SYSTEMD=0
    warn "systemd not detected — service registration will be skipped."
  fi
  ok "Pre-flight passed."
}

# ----- input -----------------------------------------------------------------
prompt() {
  local var="$1" question="$2" default="${3:-}"
  local input
  if [[ -n "$default" ]]; then
    read -r -p "  ${question} [${default}]: " input || input=""
    input="${input:-$default}"
  else
    read -r -p "  ${question}: " input || input=""
  fi
  printf -v "$var" '%s' "$input"
}

is_valid_url() {
  [[ "$1" =~ ^(ws|wss|http|https)://[^[:space:]]+$ ]]
}

collect_config() {
  log "Configuration"

  : "${HC_BACKEND_URL:=}" "${HC_BACKEND_API_URL:=}" "${HC_AGENT_HOSTNAME:=}"
  : "${HC_GPU_ENABLED:=}" "${HC_AUTO_START:=}"

  local default_host
  default_host="$(hostname 2>/dev/null || echo agent)"

  if [[ -z "$HC_BACKEND_URL" ]]; then
    while :; do
      prompt HC_BACKEND_URL "Backend WebSocket URL" "ws://192.168.0.63:37003"
      is_valid_url "$HC_BACKEND_URL" && break
      warn "URL must start with ws:// wss:// http:// https://"
    done
  fi

  if [[ -z "$HC_BACKEND_API_URL" ]]; then
    local default_api
    default_api="$(echo "$HC_BACKEND_URL" | sed -E 's|^ws(s?)://|http\1://|')"
    while :; do
      prompt HC_BACKEND_API_URL "Backend REST API URL" "$default_api"
      is_valid_url "$HC_BACKEND_API_URL" && break
      warn "URL must start with http:// or https://"
    done
  fi

  [[ -z "$HC_AGENT_HOSTNAME" ]] && \
    prompt HC_AGENT_HOSTNAME "Agent hostname" "$default_host"

  [[ -z "$HC_GPU_ENABLED" ]] && \
    prompt HC_GPU_ENABLED "Enable per-container GPU monitoring? (y/n)" "y"

  if [[ "$USE_SYSTEMD" -eq 1 && -z "$HC_AUTO_START" ]]; then
    prompt HC_AUTO_START "Auto-start on boot via systemd? (y/n)" "y"
  fi

  echo
  echo "  Backend WS  : $HC_BACKEND_URL"
  echo "  Backend API : $HC_BACKEND_API_URL"
  echo "  Hostname    : $HC_AGENT_HOSTNAME"
  echo "  GPU         : $HC_GPU_ENABLED"
  [[ "$USE_SYSTEMD" -eq 1 ]] && echo "  Auto-start  : $HC_AUTO_START"
  echo
  if [[ -z "${HC_ASSUME_YES:-}" ]]; then
    read -r -p "  Proceed? [Y/n]: " confirm
    [[ -z "$confirm" || "$confirm" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 1; }
  fi
}

# ----- extract payload -------------------------------------------------------
extract_payload() {
  log "Extracting bundled payload..."
  local self="$1" line offset
  line=$(grep -an "^${PAYLOAD_MARKER}\$" "$self" | head -1 | cut -d: -f1)
  if [[ -z "$line" ]]; then
    err "Payload marker not found — is this a built installer?"
    exit 1
  fi
  offset=$((line + 1))

  PAYLOAD_DIR="$(mktemp -d -t hc-payload.XXXXXX)"
  tail -n +"$offset" "$self" | tar x -C "$PAYLOAD_DIR"

  [[ -f "$PAYLOAD_DIR/agent-image.tar" ]] || {
    err "agent-image.tar not found in payload."
    exit 1
  }

  ok "Payload extracted ($(du -sh "$PAYLOAD_DIR" | awk '{print $1}'))."
}

# ----- install local .debs ---------------------------------------------------
# Multi-pass dpkg: a single `dpkg -i ./*.deb` often fails on ordering or
# Pre-Depends. We accept those errors, run `dpkg --configure -a` to retry
# pending configurations, then make a second install pass. This handles
# almost every real-world case without pulling in apt resolver complexity.
install_debs() {
  local dir="$1"
  local filter="${2:-}"
  local glob="$dir/*.deb"
  [[ -n "$filter" ]] && glob="$dir/${filter}*.deb"

  set +e
  dpkg -i $glob >/tmp/dpkg-pass1.log 2>&1
  local rc1=$?
  if [[ $rc1 -ne 0 ]]; then
    dpkg --configure -a >/tmp/dpkg-configure.log 2>&1 || true
    dpkg -i $glob >/tmp/dpkg-pass2.log 2>&1
    local rc2=$?
    if [[ $rc2 -ne 0 ]]; then
      err "dpkg failed to install bundled .debs after retries."
      tail -20 /tmp/dpkg-pass2.log >&2
      exit 1
    fi
  fi
  set -e
}

# ----- ensure docker is available --------------------------------------------
ensure_docker() {
  local need_engine=0 need_compose=0
  has_cmd docker || need_engine=1
  if has_cmd docker; then
    docker compose version >/dev/null 2>&1 || need_compose=1
  fi

  if [[ $need_engine -eq 0 && $need_compose -eq 0 ]]; then
    return 0
  fi

  if [[ ! -d "$PAYLOAD_DIR/docker-debs" ]]; then
    err "Docker is missing and this installer was built without the .deb bundle."
    echo "    Either install Docker manually (see docs/airgap-install.md) or" >&2
    echo "    rebuild the installer with HC_BUNDLE_DOCKER=1." >&2
    exit 1
  fi

  # dpkg only required when we actually need to install the bundled .debs.
  require_cmd dpkg "Bundled .debs require Debian/Ubuntu (dpkg). For other distros, install Docker manually first."

  if [[ $need_engine -eq 1 ]]; then
    log "Docker not found. Installing bundled .debs..."
    install_debs "$PAYLOAD_DIR/docker-debs"
  else
    log "docker compose missing. Installing compose plugin from bundle..."
    install_debs "$PAYLOAD_DIR/docker-debs" docker-compose-plugin
  fi
  ok "Docker .debs installed."

  if [[ "$USE_SYSTEMD" -eq 1 ]]; then
    log "Starting docker via systemd..."
    systemctl enable docker >/dev/null 2>&1 || true
    systemctl start  docker
  else
    # No systemd (containers, minimal images). Launch dockerd in a fresh
    # session so it survives this script's exit. nohup alone isn't enough
    # because docker-exec's session-reaping kills children when the exec
    # call returns.
    if ! pgrep -x dockerd >/dev/null 2>&1; then
      log "No systemd. Launching dockerd in detached session..."
      setsid nohup dockerd </dev/null >/tmp/hc-dockerd.log 2>&1 &
      disown 2>/dev/null || true
    fi
  fi

  for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      ok "Docker daemon is up (after ${i}s)."
      return 0
    fi
    sleep 1
  done
  err "Docker daemon never came up. Last log:"
  tail -30 /tmp/hc-dockerd.log 2>/dev/null >&2 || true
  exit 1
}

# ----- load agent image ------------------------------------------------------
load_image() {
  log "Loading agent image into Docker..."
  docker load -i "$PAYLOAD_DIR/agent-image.tar" >/dev/null
  ok "Image loaded: ${IMAGE_TAG}"
}

# ----- write env + compose ---------------------------------------------------
write_files() {
  log "Writing /opt/hypercube-agent/{.env,docker-compose.yml}..."
  mkdir -p "$INSTALL_DIR"

  local docker_gid
  docker_gid="$(getent group docker | cut -d: -f3 || echo 999)"

  local gpu_flag="true"
  [[ "$HC_GPU_ENABLED" =~ ^[Nn]$ ]] && gpu_flag="false"

  cat > "$ENV_PATH" <<EOF
BACKEND_URL=${HC_BACKEND_URL}
BACKEND_API_URL=${HC_BACKEND_API_URL}
AGENT_HOSTNAME=${HC_AGENT_HOSTNAME}
COLLECT_INTERVAL=2000
DOCKER_SOCKET=/var/run/docker.sock
HOST_PROC_PATH=/host/proc
GPU_PER_CONTAINER_ENABLED=${gpu_flag}
DOCKER_GID=${docker_gid}
EOF
  chmod 600 "$ENV_PATH"

  cat > "$COMPOSE_PATH" <<EOF
services:
  agent:
    image: ${IMAGE_TAG}
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
    group_add:
      - "\${DOCKER_GID:-999}"
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "10"
EOF
  ok "Config files written."
}

# ----- systemd ---------------------------------------------------------------
install_systemd() {
  [[ "$USE_SYSTEMD" -eq 1 ]] || return 0
  [[ "$HC_AUTO_START" =~ ^[Nn]$ ]] && { warn "Skipping systemd."; return 0; }

  log "Installing systemd unit..."
  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  cat > "$unit" <<EOF
[Unit]
Description=HyperCube monitoring agent
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1
  ok "systemd unit registered: ${SERVICE_NAME}.service"
}

# ----- start -----------------------------------------------------------------
start_agent() {
  log "Starting agent..."
  if [[ "$USE_SYSTEMD" -eq 1 && ! "$HC_AUTO_START" =~ ^[Nn]$ ]]; then
    systemctl start "${SERVICE_NAME}.service"
  else
    ( cd "$INSTALL_DIR" && docker compose up -d )
  fi

  sleep 2
  if docker ps --format '{{.Names}}' | grep -qx hypercube-agent; then
    ok "Agent container is running."
  else
    err "Agent container did not come up. Check: docker logs hypercube-agent"
    exit 1
  fi
}

# ----- main ------------------------------------------------------------------
main() {
  local self
  self="$(readlink -f "$0")"

  echo "============================================================"
  echo "  HyperCube Agent installer  (version ${VERSION})"
  echo "============================================================"
  require_root
  preflight
  collect_config
  extract_payload "$self"
  ensure_docker
  load_image
  write_files
  install_systemd
  start_agent
  echo
  ok "Install complete."
  echo
  echo "  Status : docker ps --filter name=hypercube-agent"
  echo "  Logs   : docker logs -f hypercube-agent"
  echo "  Stop   : ${USE_SYSTEMD:+systemctl stop ${SERVICE_NAME} || }(cd ${INSTALL_DIR} && docker compose down)"
  echo "  Config : ${ENV_PATH}"
  echo
  echo "  Next: approve the agent in the HyperCube backend admin page."
  exit 0
}

main "$@"
exit 0
# Anything below this line is the binary tar payload.
__PAYLOAD_BELOW__
