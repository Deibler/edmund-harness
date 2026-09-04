#!/bin/bash
# Quick-tunnel runner for the user portal (launchd-managed).
#
# Starts a free TryCloudflare quick tunnel pointing at the public-only
# listener (127.0.0.1:4749 — token-gated /u + /a routes ONLY; the PIN
# dashboard is not reachable through it). Captures the randomly-assigned
# https://*.trycloudflare.com URL into data/portal-tunnel-url, which
# portalBaseUrl() reads at send time — so newly-sent links always use the
# CURRENT tunnel even after a restart rotates the hostname.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORTAL_PUBLIC_PORT:-4749}"
URL_FILE="$REPO/data/portal-tunnel-url"
LOG="$REPO/data/portal-tunnel.log"

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
    echo "[portal-tunnel] up at $URL" >> "$LOG"
    break
  fi
  sleep 1
done

wait $CF_PID
