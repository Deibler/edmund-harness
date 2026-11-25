#!/bin/bash
# Quick-tunnel runner for the user portal (launchd-managed).
#
# Starts a free TryCloudflare quick tunnel pointing at the public-only
# listener (127.0.0.1:4749 — token-gated /u + /a routes ONLY; the PIN
# dashboard is not reachable through it). Captures the randomly-assigned
# https://*.trycloudflare.com URL into data/run/portal-tunnel-url, which
# portalBaseUrl() reads at send time — so newly-sent links always use the
# CURRENT tunnel even after a restart rotates the hostname.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORTAL_PUBLIC_PORT:-4749}"
URL_FILE="$REPO/data/run/portal-tunnel-url"
LOG="$REPO/logs/services/portal-tunnel.log"
# Seconds without an edge connection before giving up on this tunnel.
DEAD_SECS="${PORTAL_TUNNEL_DEAD_SECS:-600}"

mkdir -p "$REPO/logs/services" "$REPO/data/run"
rm -f "$URL_FILE"
: > "$LOG"

/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null' EXIT
trap 'exit 143' TERM INT

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

# Watchdog. After a long network interruption a quick tunnel cannot
# re-register: cloudflared stays alive retrying forever, so launchd never
# restarts it and the portal stays dead (2026-11-15, gateway swap). Poll
# cloudflared's own readiness endpoint (200 = connected to the edge) and exit
# once it has been down for DEAD_SECS; KeepAlive then starts a fresh tunnel.
down=0
while kill -0 $CF_PID 2>/dev/null; do
  sleep 30 & wait $!
  METRICS=$(grep -oE 'metrics server on [0-9.]+:[0-9]+' "$LOG" | head -1 | awk '{print $NF}')
  [ -n "$METRICS" ] || continue # no endpoint to ask: never restart blind
  if curl -fs -m 5 -o /dev/null "http://$METRICS/ready"; then
    down=0
  else
    down=$((down + 30))
  fi
  if [ "$down" -ge "$DEAD_SECS" ]; then
    echo "[portal-tunnel] no edge connection for ${down}s; exiting so launchd starts a fresh tunnel" >> "$LOG"
    exit 1
  fi
done

wait $CF_PID
