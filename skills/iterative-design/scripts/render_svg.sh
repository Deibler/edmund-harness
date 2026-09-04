#!/bin/bash
# Render an SVG to PNG at a target width. Preserves aspect ratio.
#
# Usage: render_svg.sh <in.svg> <out.png> [--width PX] [--background COLOR]
#   --width      output pixel width (default 2400 — good for iMessage + print sample)
#   --background CSS color to flatten transparency against (default: keep alpha)

set -e

IN=""
OUT=""
WIDTH=2400
BG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --width) WIDTH="$2"; shift 2 ;;
    --background) BG="$2"; shift 2 ;;
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
  echo "usage: render_svg.sh <in.svg> <out.png> [--width PX] [--background COLOR]" >&2
  exit 2
fi

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found. Install with: brew install librsvg" >&2
  exit 1
fi

ARGS=(-w "$WIDTH" -f png)
[[ -n "$BG" ]] && ARGS+=(-b "$BG")

rsvg-convert "${ARGS[@]}" "$IN" -o "$OUT"
echo "$OUT"
