#!/bin/bash
# On-demand Cloudflare quick tunnel for the FULL PIN dashboard (:4747).
#
# This is the model-wielded "harness" feature: Jordan texts `harness` in his
# own DM, the operator runs `dashboard-tunnel.sh up` and texts back the URL
# this prints. Unlike the standing portal tunnel (public-only listener on
# :4749), this exposes the real dashboard — so it is on-demand and
# self-expiring rather than always-on.
#
# Security posture:
#   - The dashboard enforces PIN auth server-side (HMAC cookie) on every
#     /api route; the tunnel adds reachability, not access.
#   - Random trycloudflare.com hostname, TTL-bounded (default 4h), `stop`
#     kills it early. Each new tunnel is a new origin, so the phone
#     re-enters the PIN per tunnel.
#
# Usage: dashboard-tunnel.sh [up|status|stop] [ttl_seconds]
#   up      (default) print the public URL — reuses a live tunnel if one is
#           already up, otherwise starts one (~5s)
#   status  "up <url> (pid N)" or "down"
#   stop    kill the tunnel and clean up state files
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DASHBOARD_PORT:-4747}"
CMD="${1:-up}"
TTL="${2:-14400}"
URL_FILE="$REPO/data/dashboard-tunnel-url"
PID_FILE="$REPO/data/dashboard-tunnel.pid"
LOG_FILE="$REPO/data/dashboard-tunnel.log"
HELPER="$REPO/scripts/cloudflared-quick-tunnel.sh"

# The helper (and the cloudflared under it) still running?
alive() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

current_url() { [ -f "$URL_FILE" ] && cat "$URL_FILE" 2>/dev/null || true; }

case "$CMD" in
  up)
    if alive && [ -n "$(current_url)" ]; then
      current_url
      exit 0
    fi
    rm -f "$URL_FILE" "$PID_FILE"
    : > "$LOG_FILE"
    # nohup + disown so the tunnel outlives the (model's) Bash call that
    # started it — same lifecycle trick the annotation flow relies on.
    nohup bash "$HELPER" "$PORT" "$TTL" "$URL_FILE" >>"$LOG_FILE" 2>&1 </dev/null &
    HELPER_PID=$!
    echo "$HELPER_PID" > "$PID_FILE"
    disown "$HELPER_PID" 2>/dev/null || true
    # cloudflared usually prints the URL in 2-5s; allow 25s.
    for _ in $(seq 1 100); do
      URL="$(current_url)"
      if [ -n "${URL:-}" ]; then
        echo "$URL"
        exit 0
      fi
      alive || break
      sleep 0.25
    done
    echo "ERROR: tunnel did not come up — see $LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
    ;;
  status)
    if alive && [ -n "$(current_url)" ]; then
      echo "up $(current_url) (pid $(cat "$PID_FILE"))"
    else
      echo "down"
    fi
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    # Belt and braces — only cloudflareds pointed at the DASHBOARD port; the
    # standing portal tunnel (127.0.0.1:4749) does not match this pattern.
    pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
    rm -f "$URL_FILE"
    echo "stopped"
    ;;
  *)
    echo "usage: $0 [up|status|stop] [ttl_seconds]" >&2
    exit 2
    ;;
esac
