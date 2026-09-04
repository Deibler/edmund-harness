#!/bin/bash
# Render an SVG at multiple sizes and compose into a legibility strip.
#
# The "will it hold up?" pre-flight: t-shirt print (2400), iMessage
# preview (800), thumbnail (400), phone notification (128). If a detail
# disappears at 400, the user is going to notice in their thumbnail.
#
# Usage: size_check.sh <in.svg> <out.png>

set -e

IN="$1"
OUT="$2"
if [[ -z "$IN" || -z "$OUT" ]]; then
  echo "usage: size_check.sh <in.svg> <out.png>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for size in 2400 800 400 128; do
  bash "$SCRIPT_DIR/render_svg.sh" "$IN" "$TMP/$size.png" --width "$size" >/dev/null
done

# Upscale the small ones to a common height so they appear at true relative
# size but are visible in the strip — composite shows "what the user actually sees"
python3 "$SCRIPT_DIR/variant_grid.py" "$OUT" \
  "$TMP/2400.png" "$TMP/800.png" "$TMP/400.png" "$TMP/128.png" \
  --labels "Print 2400px,Preview 800px,Thumb 400px,Notification 128px" \
  --caption "Legibility check" \
  --cols 4 >/dev/null

echo "$OUT"
