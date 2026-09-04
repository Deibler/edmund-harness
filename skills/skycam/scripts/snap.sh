#!/usr/bin/env bash
# Capture one fresh frame from the SkyStream sky camera (Lancaster County, PA).
#
# Tries four sources in order of reliability:
#   1) The SkyStream app's snapshot API — authoritative: it reads the live camera IP
#      from the app config, so it always points at the right camera even if the camera
#      moves to a new IP. Requires the app on :8080 and a dashboard login
#      (~/.config/skystream/dashboard.env) since the 2026-07-16 auth update.
#   2) The local MediaMTX relay on loopback — the camera's feed as republished by the
#      SkyStream box. Survives the camera's own address being unroutable.
#   3) camsnap against the 'skystream' camera.
#   4) ffmpeg pulling a single frame straight off RTSP — works whenever the camera is
#      reachable on the LAN. Credentials come from ~/.config/skystream/camera.env
#      (no longer hardcoded here).
#
# Prints the saved JPEG path on success; non-zero exit + stderr message on failure.
set -uo pipefail

OUT="${1:-${EDMUND_SANDBOX_PATH:-/tmp}/skycam-$(date +%Y%m%d-%H%M%S).jpg}"
mkdir -p "$(dirname "$OUT")"

SKYSTREAM_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/skystream"
# LAN topology comes from the environment so it isn't baked into the repo.
# Set these in your shell profile (or the LaunchAgent) to point at your own
# camera / SkyStream box; the localhost default works when both run here.
CAMERA_HOST="${SKYCAM_CAMERA_HOST:-}"
# Space-separated list, tried in order. First reachable wins.
read -r -a API_HOSTS <<< "${SKYSTREAM_API_HOSTS:-http://127.0.0.1:8080}"

is_jpeg() { [ -s "$OUT" ] && [ "$(file -b --mime-type "$OUT" 2>/dev/null)" = "image/jpeg" ]; }

# 1) SkyStream app snapshot endpoint (dashboard-session auth)
if [ -r "$SKYSTREAM_CONF/dashboard.env" ]; then
  # shellcheck source=/dev/null
  source "$SKYSTREAM_CONF/dashboard.env"
  if [ -n "${SKYSTREAM_DASHBOARD_PASSWORD:-}" ]; then
    JAR="$(mktemp)"
    trap 'rm -f "$JAR"' EXIT
    for h in "${API_HOSTS[@]}"; do
      if curl -fs --max-time 8 -c "$JAR" -o /dev/null \
           -X POST -H 'Content-Type: application/json' \
           -d "{\"password\":\"$SKYSTREAM_DASHBOARD_PASSWORD\"}" \
           "$h/api/auth/login" 2>/dev/null \
         && curl -fs --max-time 8 -b "$JAR" -o "$OUT" "$h/api/camera/snapshot" 2>/dev/null \
         && is_jpeg; then
        echo "$OUT"; exit 0
      fi
    done
  fi
fi

# 2) local MediaMTX relay. The SkyStream box republishes the camera's 4K feed on
#    loopback, so this keeps working when the camera's own HTTP/RTSP address is
#    unreachable — which is the normal state whenever the subnet router bridging
#    the camera's LAN is down. Local, no credentials, ~1s.
RELAY="${SKYSTREAM_RELAY_RTSP:-rtsp://127.0.0.1:8554/cam}"
if ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 8000000 -i "$RELAY" \
     -frames:v 1 -q:v 2 -y "$OUT" </dev/null >/dev/null 2>&1 && is_jpeg; then
  echo "$OUT"; exit 0
fi

# 3) camsnap configured camera
if command -v camsnap >/dev/null 2>&1; then
  if camsnap snap skystream --out "$OUT" >/dev/null 2>&1 && is_jpeg; then
    echo "$OUT"; exit 0
  fi
fi

# 4) ffmpeg direct RTSP single frame (creds from camera.env)
if [ -r "$SKYSTREAM_CONF/camera.env" ]; then
  # shellcheck source=/dev/null
  source "$SKYSTREAM_CONF/camera.env"
fi
if [ -n "${SKYSTREAM_CAMERA_USER:-}" ] && [ -n "${SKYSTREAM_CAMERA_PASSWORD:-}" ]; then
  RTSP="rtsp://${SKYSTREAM_CAMERA_USER}:${SKYSTREAM_CAMERA_PASSWORD}@${CAMERA_HOST}:554/cam/realmonitor?channel=1&subtype=0"
  if ffmpeg -nostdin -loglevel error -rtsp_transport tcp -i "$RTSP" \
       -frames:v 1 -q:v 2 -y "$OUT" </dev/null >/dev/null 2>&1 && is_jpeg; then
    echo "$OUT"; exit 0
  fi
fi

echo "ERROR: could not capture a frame from the sky camera (is the camera on the LAN / app running?)" >&2
exit 1
