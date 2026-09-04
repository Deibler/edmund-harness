#!/bin/bash
# Trace a raster sketch (hand drawing, marker mockup, whiteboard photo) to
# a ONE-COLOR SVG (B&W silhouette / line art) so it can be iteratively edited.
#
# For COLOR raster input (logos, badges, multi-color marks) use trace_color.sh
# (vtracer) — this script will collapse all color to a single fill.
#
# Uses potrace. The input should be high-contrast; if it's a photo, the script
# will binarize it first with ImageMagick.
#
# Usage: trace_sketch.sh <in.{png,jpg,heic}> <out.svg> [--color "#1B2A49"] [--threshold 50%]

set -e

IN=""
OUT=""
COLOR="#1B2A49"
THRESHOLD="50%"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --color) COLOR="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$IN" ]]; then IN="$1"
      elif [[ -z "$OUT" ]]; then OUT="$1"
      else echo "too many positional args" >&2; exit 2
      fi
      shift ;;
  esac
done

if [[ -z "$IN" || -z "$OUT" ]]; then
  echo "usage: trace_sketch.sh <in> <out.svg> [--color HEX] [--threshold PCT]" >&2
  exit 2
fi

for dep in potrace magick; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "missing dependency: $dep" >&2
    exit 1
  fi
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Binarize: grayscale, normalize, threshold, output PBM for potrace
magick "$IN" -colorspace Gray -normalize -threshold "$THRESHOLD" "$TMP/bin.pbm"

potrace "$TMP/bin.pbm" --svg --color "$COLOR" --turnpolicy minority \
  --alphamax 1 --opttolerance 0.2 --output "$OUT"

echo "$OUT"
