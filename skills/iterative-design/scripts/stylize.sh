#!/bin/bash
# Photoshop-style filters via G'MIC.
#
# Use for stylizing a raster (embedded illustration, background texture,
# mood-shift variation) before embedding in an SVG or sending a round.
# For vector-native stylization prefer primitive (photo_to_svg.sh) or
# vtracer (trace_color.sh).
#
# Presets — verified against G'MIC 3.7. If a preset fails on a newer
# version, fall back to `--raw 'gmic filter args'` or call gmic directly.
#
#   sepia           vintage sepia tone
#   pencilbw        black-and-white pencil sketch
#   sketchbw        looser pencil sketch (lighter)
#   quantize N      reduce to N flat color bands (pre-vectorize prep)
#   smooth          anisotropic smoothing (paint-like without the mess)
#   raw 'CMD ARGS'  pass arbitrary G'MIC commands through
#
# Usage:
#   stylize.sh <in> <out> <preset> [args...]
#   stylize.sh in.png out.png sepia
#   stylize.sh in.png out.png pencilbw
#   stylize.sh in.png out.png quantize 6
#   stylize.sh in.png out.png raw 'blur 3 sharpen 200'
set -e

IN="$1"; OUT="$2"; PRESET="$3"
if [[ -z "$IN" || -z "$OUT" || -z "$PRESET" ]]; then
  echo "usage: stylize.sh <in> <out> <preset> [args...]" >&2
  echo "presets: sepia pencilbw sketchbw quantize smooth raw" >&2
  exit 2
fi
shift 3

if ! command -v gmic >/dev/null 2>&1; then
  echo "gmic not installed. Install with: brew install gmic" >&2
  exit 1
fi

case "$PRESET" in
  sepia)
    gmic "$IN" sepia -output "$OUT" ;;
  pencilbw)
    # args: size,amplitude,sharpness,gauss,dark
    ARGS="${1:-0.3,60,200,200,1}"
    gmic "$IN" pencilbw "$ARGS" -output "$OUT" ;;
  sketchbw)
    # arg: number of passes (1-5, higher = more sketchy)
    PASSES="${1:-2}"
    gmic "$IN" sketchbw "$PASSES" -output "$OUT" ;;
  quantize)
    # arg: number of color bins (2-16 typical)
    BINS="${1:-6}"
    gmic "$IN" quantize "$BINS",1 -output "$OUT" ;;
  smooth)
    # anisotropic smoothing — paint-like
    ARGS="${1:-60,0.9,0.1,0.6,1.1,0.8,30,2,0}"
    gmic "$IN" smooth "$ARGS" -output "$OUT" ;;
  raw)
    if [[ -z "$1" ]]; then echo "raw preset needs a gmic command string" >&2; exit 2; fi
    eval gmic "\"$IN\"" "$1" -output "\"$OUT\"" ;;
  *)
    echo "unknown preset: $PRESET" >&2
    echo "presets: sepia pencilbw sketchbw quantize smooth raw" >&2
    exit 2 ;;
esac

echo "$OUT"
