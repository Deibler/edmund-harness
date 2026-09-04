#!/bin/bash
# Artistic geometric approximation of a raster photo as an SVG of N shapes.
#
# Uses `primitive`. Output is crunchy, stylized, poster-like — NOT a
# faithful trace. For faithful color tracing use trace_color.sh (vtracer).
#
# Good for:
#   - hero graphics from a photo (triangle-style portraits, abstract posters)
#   - stylized mascot stand-ins while iterating composition
#   - reducing a photo to a screen-printable 20-shape silhouette
#
# Modes (shape vocabulary):
#   combo      — mix of everything (creative)
#   triangle   — triangles only (default; most poster-like)
#   rect       — axis-aligned rects (pixel-mosaic look)
#   ellipse    — ellipses
#   circle     — circles
#   rotrect    — rotated rectangles
#   beziers    — cubic bezier strokes (wispy)
#   rotellipse — rotated ellipses
#   polygon    — arbitrary polygons
#
# Usage: photo_to_svg.sh <in.{png,jpg}> <out.svg> [--shapes N] [--mode MODE] [--alpha 0..255]
set -e

IN=""; OUT=""
SHAPES="200"
MODE="1"
ALPHA="128"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shapes|-n) SHAPES="$2"; shift 2 ;;
    --alpha|-a) ALPHA="$2"; shift 2 ;;
    --mode|-m)
      case "$2" in
        combo) MODE="0" ;;
        triangle) MODE="1" ;;
        rect) MODE="2" ;;
        ellipse) MODE="3" ;;
        circle) MODE="4" ;;
        rotrect) MODE="5" ;;
        beziers) MODE="6" ;;
        rotellipse) MODE="7" ;;
        polygon) MODE="8" ;;
        *) MODE="$2" ;;
      esac
      shift 2 ;;
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
  echo "usage: photo_to_svg.sh <in> <out.svg> [--shapes N] [--mode MODE]" >&2
  exit 2
fi

if ! command -v primitive >/dev/null 2>&1; then
  echo "primitive not installed. Install with: GOTOOLCHAIN=go1.25.0 go install github.com/fogleman/primitive@latest" >&2
  exit 1
fi

primitive -i "$IN" -o "$OUT" -n "$SHAPES" -m "$MODE" -a "$ALPHA"
echo "$OUT"
