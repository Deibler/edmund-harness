#!/bin/bash
#
# Run a Cloudflare quick tunnel for a local port, write the public URL to a
# file once cloudflared is ready, then sleep TTL seconds and exit.
#
# Lifecycle — why bash, not a pure Bun implementation:
#   - cloudflared writes the trycloudflare.com URL once in its startup banner
#     and then keeps streaming keepalive logs. If a parent stops reading its
#     stderr, the pipe buffer fills and cloudflared blocks. This script
#     redirects cloudflared output to a temp file so there's no backpressure,
#     then greps for the URL.
#   - The TS caller needs the child to outlive the MCP subprocess (which dies
#     when Claude's turn ends, ~seconds later). A detached bash process
#     works; a Bun-spawned JS timer does not.
#   - The SIGTERM trap gives the caller a clean way to end the tunnel early
#     (on annotation submit) without racing cloudflared's own signal handling.
#
# Usage: cloudflared-quick-tunnel.sh PORT TTL_SECONDS URL_OUT_FILE
#   PORT          local port cloudflared forwards to (e.g. 4747)
#   TTL_SECONDS   how long to keep the tunnel alive before self-exit
#   URL_OUT_FILE  path where the public https://<slug>.trycloudflare.com URL
#                 is written once the tunnel is ready

set -u

PORT=${1:?port required}
TTL=${2:?ttl seconds required}
URL_OUT_FILE=${3:?url out file required}

LOG_FILE=$(mktemp -t edmund-cf-log)

# Kill cloudflared and clean up the log file on any exit path: normal timeout,
# SIGTERM from the caller, or SIGINT during interactive testing.
cleanup() {
  if [ -n "${CF_PID:-}" ]; then
    kill "$CF_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE" "$URL_OUT_FILE" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT EXIT

# Start cloudflared detached-ish (still in our process group so the trap hits
# it). --no-autoupdate prevents cloudflared from trying to self-upgrade in
# the middle of a tunnel.
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate \
  >"$LOG_FILE" 2>&1 &
CF_PID=$!

# Poll the log for the public URL. Cloudflared usually prints it within
# 2–4 seconds; cap at 20s so we never wait forever.
for _ in $(seq 1 80); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo "$URL" >"$URL_OUT_FILE"
    break
  fi
  # If cloudflared died before producing a URL (e.g. binary missing / port
  # blocked), stop waiting.
  if ! kill -0 "$CF_PID" 2>/dev/null; then
    exit 1
  fi
  sleep 0.25
done

# Hold the tunnel open for TTL. Run sleep in the background and `wait` for
# it so an incoming SIGTERM (from the dashboard's kill-on-submit handler)
# can interrupt immediately and fire the trap. If we instead blocked on a
# foreground `sleep "$TTL"`, bash would queue the signal until sleep
# returned — meaning a 15-minute tunnel stays alive for the full 15 minutes
# after the user already submitted.
sleep "$TTL" &
wait $!
