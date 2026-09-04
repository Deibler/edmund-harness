#!/bin/bash
# Stop instant-share tunnel(s) and cleanup
# Usage: stop.sh [--keep-artifact] [artifact_id_or_path]
#
# With no args: stops ALL active tunnels
# With artifact_id or path: stops only that one

set -e

CONFIG_DIR="${INSTANT_SHARE_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.config}"
TUNNELS_DIR="${CONFIG_DIR}/tunnels"
KEEP_ARTIFACT=false
TARGET=""

# Legacy state file
LEGACY_STATE="${CONFIG_DIR}/active_tunnel.state"

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --keep-artifact) KEEP_ARTIFACT=true; shift ;;
        *) TARGET="$1"; shift ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAP_ARGS=(--config-dir "$CONFIG_DIR")
if [[ -n "$TARGET" ]]; then
    REAP_ARGS+=(--target "$TARGET")
else
    REAP_ARGS+=(--all)
fi

# reap.py validates the recorded PID, command, artifact path, local port, and
# start time before signaling. Never use a broad pkill here: named SkyStream
# and Edmund portal tunnels are intentionally long-lived.
python3 "$SCRIPT_DIR/reap.py" "${REAP_ARGS[@]}"

echo ""
echo "All stopped. URLs are no longer valid."
