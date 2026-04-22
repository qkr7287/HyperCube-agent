#!/usr/bin/env bash
# Spin up a remote dev agent instance with Mutagen-synced source.
# Usage: ./scripts/dev-on.sh <16|63>

set -euo pipefail

TARGET="${1:?target required: 16|63}"

case "$TARGET" in
  16)
    SSH_ALIAS=hc-dev-16
    REMOTE_DIR=/home/agics-ai/ts/agent-dev
    SUFFIX=16
    DOCKER_GID=999
    ;;
  63)
    SSH_ALIAS=hc-dev-63
    REMOTE_DIR=/home/agics/ts/agent-dev
    SUFFIX=63
    DOCKER_GID=138
    ;;
  *)
    echo "unknown target: $TARGET (expected 16 or 63)" >&2
    exit 1
    ;;
esac

SESSION_NAME="agent-$TARGET"

echo ">>> [$TARGET] ensuring remote workspace at $REMOTE_DIR"
ssh "$SSH_ALIAS" "mkdir -p $REMOTE_DIR"

echo ">>> [$TARGET] ensuring Mutagen session '$SESSION_NAME'"
if mutagen sync list "$SESSION_NAME" >/dev/null 2>&1; then
  mutagen sync resume "$SESSION_NAME" >/dev/null 2>&1 || true
else
  mutagen sync create \
    --name="$SESSION_NAME" \
    --mode=two-way-resolved \
    --ignore-vcs \
    --ignore="node_modules,dist,build,.turbo,coverage,.nyc_output,.env,.env.dev" \
    "$(pwd)" \
    "$SSH_ALIAS:$REMOTE_DIR"
fi

echo ">>> [$TARGET] waiting for initial sync..."
for _ in $(seq 1 60); do
  if mutagen sync list "$SESSION_NAME" | grep -qE "Status: (Watching|Scanning complete)"; then
    break
  fi
  sleep 1
done

echo ">>> [$TARGET] ensuring .env.dev on remote"
if ! ssh "$SSH_ALIAS" "[ -f $REMOTE_DIR/.env.dev ]"; then
  ssh "$SSH_ALIAS" "cp $REMOTE_DIR/.env.dev.example $REMOTE_DIR/.env.dev && \
    sed -i \"s/^HOSTNAME_SUFFIX=.*/HOSTNAME_SUFFIX=$SUFFIX/\" $REMOTE_DIR/.env.dev && \
    sed -i \"s/^AGENT_HOSTNAME=.*/AGENT_HOSTNAME=server_${SUFFIX}_dev/\" $REMOTE_DIR/.env.dev && \
    sed -i \"s/^DOCKER_GID=.*/DOCKER_GID=$DOCKER_GID/\" $REMOTE_DIR/.env.dev"
fi

echo ">>> [$TARGET] starting dev compose"
ssh "$SSH_ALIAS" "cd $REMOTE_DIR && docker compose -p hypercube-agent-dev -f docker-compose.dev.yml up -d --build"

echo
echo "agent-$TARGET is up. tail logs with:"
echo "  ssh $SSH_ALIAS 'cd $REMOTE_DIR && docker compose -p hypercube-agent-dev -f docker-compose.dev.yml logs -f'"
