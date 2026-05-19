#!/bin/bash
# Build a single-file self-extracting installer for an air-gapped target.
#
# Output: dist-installer/hypercube-agent-installer-<version>.sh
#
# Usage:
#   ./scripts/build-installer.sh [version]
#
# The installer bundles the agent docker image AND the Docker Engine .debs
# (Ubuntu 24.04 amd64) so a target host with nothing but base Ubuntu can
# install end-to-end without the network.
#
# Skip the .deb bundle (smaller installer, target must already have Docker)
# by setting:  HC_BUNDLE_DOCKER=0  ./scripts/build-installer.sh
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)}"
IMAGE_TAG="hypercube-agent:${VERSION}"
DIST_DIR="${REPO_ROOT}/dist-installer"
IMAGE_TAR="${DIST_DIR}/agent-image-${VERSION}.tar"
DEBS_DIR="${DIST_DIR}/docker-debs"
PAYLOAD_TAR="${DIST_DIR}/payload-${VERSION}.tar"
TEMPLATE="${REPO_ROOT}/installer/install-template.sh"
BUNDLE_DOCKER="${HC_BUNDLE_DOCKER:-1}"

# Disambiguate filenames so full + slim installers can co-exist in
# dist-installer/. Full ships Ubuntu 24.04 .deb bundle; slim is
# distro-agnostic but requires Docker pre-installed on the target.
if [[ "$BUNDLE_DOCKER" == "1" ]]; then
  INSTALLER="${DIST_DIR}/hypercube-agent-installer-${VERSION}-ubuntu24.sh"
else
  INSTALLER="${DIST_DIR}/hypercube-agent-installer-${VERSION}-slim.sh"
fi

log()  { printf '\033[1;34m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[X]\033[0m %s\n' "$*" >&2; }

[[ -f "$TEMPLATE" ]] || { err "Template missing: $TEMPLATE"; exit 1; }
command -v docker >/dev/null || { err "docker not found"; exit 1; }

mkdir -p "$DIST_DIR"

log "Building image ${IMAGE_TAG}..."
BUILD_CTX="$REPO_ROOT"
if command -v cygpath >/dev/null 2>&1; then
  BUILD_CTX="$(cygpath -w "$REPO_ROOT")"
fi
docker build -t "$IMAGE_TAG" "$BUILD_CTX" >/dev/null
ok "Image built."

log "Saving agent image to tar..."
docker save "$IMAGE_TAG" > "$IMAGE_TAR"
ok "Saved agent-image.tar ($(du -h "$IMAGE_TAR" | awk '{print $1}'))."

if [[ "$BUNDLE_DOCKER" == "1" ]]; then
  if ! ls "$DEBS_DIR"/*.deb >/dev/null 2>&1; then
    log "Docker .debs missing — running fetch-docker-debs.sh..."
    bash "${REPO_ROOT}/scripts/fetch-docker-debs.sh"
  else
    ok "Re-using cached .debs in ${DEBS_DIR} ($(du -sh "$DEBS_DIR" | awk '{print $1}'))"
  fi
fi

log "Packing payload tar..."
# Single uncompressed tar containing agent-image.tar [+ docker-debs/].
# The installer's `tar x` reads it back. Uncompressed because the docker
# image's layers are already gzipped internally — outer compression buys
# almost nothing and would force the target to have gzip available.
PACK_DIR="$(mktemp -d)"
trap 'rm -rf "$PACK_DIR"' EXIT
cp "$IMAGE_TAR" "$PACK_DIR/agent-image.tar"
if [[ "$BUNDLE_DOCKER" == "1" && -d "$DEBS_DIR" ]]; then
  cp -r "$DEBS_DIR" "$PACK_DIR/docker-debs"
fi
( cd "$PACK_DIR" && tar cf "$PAYLOAD_TAR" . )
ok "Payload packed ($(du -h "$PAYLOAD_TAR" | awk '{print $1}'))."

log "Composing installer..."
sed "s/__VERSION__/${VERSION}/g" "$TEMPLATE" > "$INSTALLER"
cat "$PAYLOAD_TAR" >> "$INSTALLER"
chmod +x "$INSTALLER"
rm -f "$IMAGE_TAR" "$PAYLOAD_TAR"

ok "Installer built: $INSTALLER ($(du -h "$INSTALLER" | awk '{print $1}'))"
echo
echo "  Transfer this single file to the air-gapped host and run:"
echo "    sudo ./$(basename "$INSTALLER")"
