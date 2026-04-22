#!/usr/bin/env bash
# Tear down a remote dev agent instance and pause its Mutagen session.
# Usage: ./scripts/dev-off.sh <16|63> [--terminate]

set -euo pipefail

TARGET="${1:?target required: 16|63}"
MODE="${2:-pause}"

case "$TARGET" in
  16) SSH_ALIAS=hc-dev-16; REMOTE_DIR=/home/agics-ai/ts/agent-dev ;;
  63) SSH_ALIAS=hc-dev-63; REMOTE_DIR=/home/agics/ts/agent-dev ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

SESSION_NAME="agent-$TARGET"

echo ">>> [$TARGET] stopping dev compose"
ssh "$SSH_ALIAS" "cd $REMOTE_DIR && docker compose -p hypercube-agent-dev -f docker-compose.dev.yml down" || true

if [ "$MODE" = "--terminate" ]; then
  echo ">>> [$TARGET] terminating Mutagen session '$SESSION_NAME'"
  mutagen sync terminate "$SESSION_NAME" || true
else
  echo ">>> [$TARGET] pausing Mutagen session '$SESSION_NAME'"
  mutagen sync pause "$SESSION_NAME" || true
fi
