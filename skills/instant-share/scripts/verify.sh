#!/bin/bash
# Verify that the active tunnel URL is working
# Usage: verify.sh [url]
#
# If no URL provided, checks the active tunnel from state file.
# Returns exit code 0 if working, 1 if not.

set -e

CONFIG_DIR="${INSTANT_SHARE_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.config}"
STATE_FILE="${CONFIG_DIR}/active_tunnel.state"

URL="$1"

# If no URL provided, get from state
if [[ -z "$URL" ]]; then
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "Error: No active tunnel and no URL provided" >&2
        exit 1
    fi
    source "$STATE_FILE"
    URL="$SECURE_URL"
fi

if [[ -z "$URL" ]]; then
    echo "Error: No URL to verify" >&2
    exit 1
fi

echo "Verifying: $URL"

# Test the URL
HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL" 2>/dev/null || echo "000")

case $HTTP_STATUS in
    200)
        echo "Status: VERIFIED (HTTP 200)"
        exit 0
        ;;
    403)
        echo "Status: AUTH REQUIRED (HTTP 403 - tunnel working, bad/missing token)"
        exit 0
        ;;
    410)
        echo "Status: KILLED (HTTP 410 - artifact was stopped)"
        exit 1
        ;;
    404)
        echo "Status: NOT FOUND (HTTP 404)"
        exit 1
        ;;
    000)
        echo "Status: UNREACHABLE (connection failed)"
        exit 1
        ;;
    502|503|504)
        echo "Status: TUNNEL DOWN (HTTP $HTTP_STATUS)"
        exit 1
        ;;
    *)
        echo "Status: UNKNOWN (HTTP $HTTP_STATUS)"
        exit 1
        ;;
esac
