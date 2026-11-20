#!/bin/bash
# Quick-tunnel runner for the Grok connector (launchd-managed).
#
# Starts a free TryCloudflare quick tunnel pointing at the daemon's Grok MCP
# listener (127.0.0.1:[grok].port, default 4796 — token-gated /mcp only). The
# randomly-assigned https://*.trycloudflare.com URL is written to
# data/grok-tunnel-url, and the full connector URL to data/grok-connector-url.
#
# The hostname CHANGES every time this restarts, so the connector URL pasted into
# Grok goes stale then. A named tunnel (stable hostname) needs a Cloudflare token
# with Tunnel and DNS permissions; see docs/grok-channel.md.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${GROK_PORT:-4796}"
URL_FILE="$REPO/data/grok-tunnel-url"
LOG="$REPO/data/grok-tunnel.log"

rm -f "$URL_FILE"
: > "$LOG"

/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null' EXIT TERM INT

# cloudflared prints the assigned URL within a few seconds — capture it.
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  if [ -n "${URL:-}" ]; then
    printf '%s' "$URL" > "$URL_FILE"
    echo "[grok-tunnel] up at $URL" >> "$LOG"
    break
  fi
  sleep 1
done

wait $CF_PID
