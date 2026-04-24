#!/bin/sh
# Dev container entrypoint.
#
# `tsx watch` does not respawn the child Node process when it crashes — it
# waits silently for a file change before trying again. When that happens in
# a long-lived dev container the agent goes dark for hours: tsx itself stays
# alive as PID 1 so docker's restart policy never fires.
#
# This supervisor polls for the presence of tsx's Node child. If the child
# is missing for several consecutive checks we kill tsx and exit non-zero,
# which lets `restart: unless-stopped` bring the container back up with a
# fresh child. Hot-reload on file changes keeps working as before.

set -u

CHECK_INTERVAL=${DEV_SUPERVISOR_INTERVAL:-10}
MAX_MISSES=${DEV_SUPERVISOR_MAX_MISSES:-3}
STARTUP_GRACE=${DEV_SUPERVISOR_STARTUP_GRACE:-20}

if [ ! -f node_modules/.installed ]; then
    npm install --no-audit --no-fund && touch node_modules/.installed
fi

tsx watch src/index.ts &
TSX_PID=$!

trap 'kill -TERM "$TSX_PID" 2>/dev/null; wait "$TSX_PID" 2>/dev/null; exit 0' TERM INT

sleep "$STARTUP_GRACE"

misses=0
while kill -0 "$TSX_PID" 2>/dev/null; do
    if pgrep -P "$TSX_PID" -x node >/dev/null 2>&1; then
        misses=0
    else
        misses=$((misses + 1))
        echo "[dev-supervisor] tsx has no node child (miss $misses/$MAX_MISSES)"
        if [ "$misses" -ge "$MAX_MISSES" ]; then
            echo "[dev-supervisor] child gone — exiting so docker restarts the container"
            kill -TERM "$TSX_PID" 2>/dev/null
            wait "$TSX_PID" 2>/dev/null
            exit 1
        fi
    fi
    sleep "$CHECK_INTERVAL"
done

wait "$TSX_PID"
echo "[dev-supervisor] tsx exited with code $?"
exit $?
