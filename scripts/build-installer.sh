#!/bin/bash
# Build a single-file self-extracting installer for an air-gapped target.
#
# Output: dist/hypercube-agent-installer-<version>.sh
#
# Usage:
#   ./scripts/build-installer.sh [version]
#
# The version defaults to package.json's version field. Run this on an
# internet-connected build host; the result is portable to any Linux
# host with Docker + tar + bash.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)}"
IMAGE_TAG="hypercube-agent:${VERSION}"
DIST_DIR="${REPO_ROOT}/dist-installer"
IMAGE_TAR="${DIST_DIR}/agent-image-${VERSION}.tar"
INSTALLER="${DIST_DIR}/hypercube-agent-installer-${VERSION}.sh"
TEMPLATE="${REPO_ROOT}/installer/install-template.sh"

log()  { printf '\033[1;34m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[X]\033[0m %s\n' "$*" >&2; }

[[ -f "$TEMPLATE" ]] || { err "Template missing: $TEMPLATE"; exit 1; }
command -v docker >/dev/null || { err "docker not found"; exit 1; }

mkdir -p "$DIST_DIR"

log "Building image ${IMAGE_TAG}..."
docker build -t "$IMAGE_TAG" "$REPO_ROOT" >/dev/null
ok "Image built."

log "Saving image to tar..."
# Use stdout redirect rather than -o: docker.exe on Windows can't resolve
# git-bash style paths like /c/Users/... that we get from $REPO_ROOT.
docker save "$IMAGE_TAG" > "$IMAGE_TAR"
ok "Saved $(du -h "$IMAGE_TAR" | awk '{print $1}')."

log "Composing installer..."
# Substitute the version placeholder, then append the binary tar payload.
sed "s/__VERSION__/${VERSION}/g" "$TEMPLATE" > "$INSTALLER"
cat "$IMAGE_TAR" >> "$INSTALLER"
chmod +x "$INSTALLER"
rm -f "$IMAGE_TAR"

ok "Installer built: $INSTALLER ($(du -h "$INSTALLER" | awk '{print $1}'))"
echo
echo "  Transfer this single file to the air-gapped host and run:"
echo "    sudo ./$(basename "$INSTALLER")"
