#!/bin/bash
# Aggressive SVG optimization for FINAL export only.
#
# Runs svgo's multipass pipeline — merges paths, removes defaults,
# collapses transforms, strips editor cruft. Do NOT run this between
# iteration rounds; it breaks round-trippability (your `transform=` and
# `id=` anchors can vanish). For in-loop cleanup use svg_optimize.py.
#
# Usage: svgo_final.sh <in.svg> <out.svg> [--pretty]
set -e

IN=""; OUT=""
PRETTY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pretty) PRETTY="--pretty"; shift ;;
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
  echo "usage: svgo_final.sh <in.svg> <out.svg> [--pretty]" >&2
  exit 2
fi

if ! command -v svgo >/dev/null 2>&1; then
  echo "svgo not installed. Install with: npm i -g svgo" >&2
  exit 1
fi

svgo --multipass $PRETTY -i "$IN" -o "$OUT" >/dev/null
before=$(wc -c < "$IN")
after=$(wc -c < "$OUT")
pct=$(awk "BEGIN{printf \"%.1f\", (1 - $after/$before) * 100}")
echo "$OUT  ($before -> $after bytes, -${pct}%)"
