#!/bin/bash
# AI-powered background removal (rembg / U²-Net).
#
# Produces a transparent PNG that preserves ALL interior colors.
# Prefer this over `magick -fuzz` for any non-trivial subject — fuzz-based
# background removal damages interior regions that happen to match the
# background hue (e.g. a red logo on a white field where "red ->
# transparent" also eats the reddish shadows inside the logo).
#
# Models:
#   u2net             default, general-purpose, best all-rounder
#   u2netp            lighter/faster variant
#   isnet-general-use sharper edges, better for logos with thin strokes
#   silueta           optimized for people/silhouettes
#   u2net_cloth_seg   clothing segmentation
#
# Usage: remove_bg.sh <in.{png,jpg,heic}> <out.png> [--model NAME] [--alpha-matting]
set -e

IN=""; OUT=""
MODEL="u2net"
ALPHA_MATTING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --alpha-matting) ALPHA_MATTING=1; shift ;;
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
  echo "usage: remove_bg.sh <in> <out.png> [--model NAME] [--alpha-matting]" >&2
  exit 2
fi

if ! command -v rembg >/dev/null 2>&1; then
  echo "rembg not installed. Install with: pipx install 'rembg[cli]'" >&2
  exit 1
fi

ARGS=(i -m "$MODEL")
[[ "$ALPHA_MATTING" -eq 1 ]] && ARGS+=(-a)

rembg "${ARGS[@]}" "$IN" "$OUT"
echo "$OUT"
