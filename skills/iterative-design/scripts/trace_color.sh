#!/bin/bash
# Trace a raster image to a FULL-COLOR SVG using vtracer.
#
# Use this for anything with color — logos, badges, multi-color marks.
# For B&W line art (hand sketches, silhouettes) use trace_sketch.sh.
#
# If the input has a flat white/solid background that should be transparent
# in the vector output, run remove_bg.sh FIRST, then trace the transparent PNG.
# Tracing "white with a red logo" directly will produce a giant white polygon
# behind the logo.
#
# Usage:
#   trace_color.sh <in.{png,jpg}> <out.svg>
#       [--mode polygon|spline]      # polygon = crisp, spline = smooth curves (default polygon)
#       [--color-precision N]        # 1-8, higher = more color fidelity (default 8)
#       [--filter-speckle N]         # drop clusters smaller than NxN pixels (default 4)
#       [--gradient-step N]          # color quantization step (default 16; lower = more colors)
#       [--corner-threshold DEG]     # sharpness threshold, default 60
#       [--segment-length N]         # path segment length, default 4
set -e

IN=""; OUT=""
MODE="polygon"
PREC="8"
SPECKLE="4"
GRADIENT="16"
CORNER="60"
SEGMENT="4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --color-precision) PREC="$2"; shift 2 ;;
    --filter-speckle) SPECKLE="$2"; shift 2 ;;
    --gradient-step) GRADIENT="$2"; shift 2 ;;
    --corner-threshold) CORNER="$2"; shift 2 ;;
    --segment-length) SEGMENT="$2"; shift 2 ;;
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
  echo "usage: trace_color.sh <in> <out.svg> [--mode polygon|spline] [--color-precision N] [--filter-speckle N]" >&2
  exit 2
fi

if ! command -v vtracer >/dev/null 2>&1; then
  echo "vtracer not installed. Install with: cargo install vtracer" >&2
  exit 1
fi

vtracer \
  --input "$IN" \
  --output "$OUT" \
  --mode "$MODE" \
  --color_precision "$PREC" \
  --filter_speckle "$SPECKLE" \
  --gradient_step "$GRADIENT" \
  --corner_threshold "$CORNER" \
  --segment_length "$SEGMENT"

echo "$OUT"
