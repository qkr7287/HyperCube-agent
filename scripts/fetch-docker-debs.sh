#!/bin/bash
# Fetch Docker Engine + compose plugin .debs (with all transitive deps) for
# Ubuntu 24.04 amd64. Runs the apt download inside a throwaway ubuntu:24.04
# container, so this script works on any host with Docker — including
# Mac and Windows where you don't have apt locally.
#
# Output: dist-installer/docker-debs/*.deb
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/dist-installer/docker-debs"

log()  { printf '\033[1;34m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[X]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || err "docker not found on host"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.deb 2>/dev/null || true

OUT_DIR_HOST="$OUT_DIR"
if command -v cygpath >/dev/null 2>&1; then
  OUT_DIR_HOST="$(cygpath -w "$OUT_DIR")"
fi

log "Pulling ubuntu:24.04 (one-time)..."
docker pull ubuntu:24.04 >/dev/null
ok "Base image ready."

log "Resolving + downloading Docker .debs (this takes a minute)..."
# Inside the container: register Docker's apt repo, then `apt-get install
# --download-only --reinstall` so the .deb cache contains the FULL closure
# of files needed on a bare target host (not just packages missing from
# this build container).
docker run --rm \
  -v "${OUT_DIR_HOST}:/output" \
  ubuntu:24.04 bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg apt-transport-https >/dev/null

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq

    # --reinstall forces re-fetching even of already-installed deps so the
    # cache reflects what a target machine actually needs. We exclude
    # Recommends (--no-install-recommends) because they pull in heavy
    # extras (git, python3, networkd-dispatcher, ...) whose own transitive
    # closure exceeds what apt-get install --download-only computes,
    # leaving the bundle structurally incomplete on the target host.
    apt-get install -y --no-install-recommends --download-only --reinstall \
      docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin >/dev/null

    cp /var/cache/apt/archives/*.deb /output/
    chmod 644 /output/*.deb
    echo "--- bundled .debs ---"
    ls -lh /output/*.deb
  '

count=$(ls -1 "$OUT_DIR"/*.deb 2>/dev/null | wc -l)
size=$(du -sh "$OUT_DIR" | awk '{print $1}')
ok "Fetched ${count} .deb files (${size}) -> ${OUT_DIR}"
