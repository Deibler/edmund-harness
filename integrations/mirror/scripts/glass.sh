#!/usr/bin/env bash
# Photograph the glass.
#
# grim on the Pi captures the Wayland output the kiosk is painting, which is
# the only honest picture of the mirror: mirror-ui rendered in the real
# Chromium, at the real 1080x1920, with the real fonts (or without them, which
# is how the missing-@font-face regression was found in the first place).
#
# A laptop browser is not a substitute. It has different fonts, a different
# device pixel ratio, and no two-way glass in front of it.
#
#   integrations/mirror/scripts/glass.sh [output.png] [--settle SECONDS]
#
# Settle exists because the store write, the 300 ms outbox drain, the websocket
# push and the CSS transition are four separate delays. Screenshotting too
# early photographs the animation, not the design.
set -euo pipefail

PI_HOST=${MIRROR_PI_HOST:?set MIRROR_PI_HOST to user@host of the mirror Pi}
PI_PASS=${MIRROR_PI_PASS:?set MIRROR_PI_PASS (never commit a value for it)}
OUT=${1:-glass.png}
SETTLE=2
if [[ ${2-} == "--settle" ]]; then SETTLE=${3:-2}; fi

sleep "$SETTLE"

# StrictHostKeyChecking is off because this Pi gets reflashed; the alternative
# is a known_hosts edit every time, which is the kind of friction that ends
# with someone screenshotting their laptop instead.
sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "$PI_HOST" \
  'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 grim /tmp/glass.png' >&2

sshpass -p "$PI_PASS" scp -o StrictHostKeyChecking=no -o LogLevel=ERROR \
  "$PI_HOST:/tmp/glass.png" "$OUT" >&2

# Report the geometry: a screenshot that is not 1080x1920 means the kiosk lost
# the rotation, and every judgement made from it would be about the wrong shape.
if command -v sips >/dev/null 2>&1; then
  sips -g pixelWidth -g pixelHeight "$OUT" | tail -2 | tr -d ' ' | paste -sd' ' -
fi
echo "$OUT"
