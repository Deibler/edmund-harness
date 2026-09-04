#!/bin/bash
# Validate an SVG as well-formed XML and flag common iteration-breaking issues.
#
# Usage: svg_validate.sh <file.svg>
#
# Exits 0 on clean, 1 with a list of issues.

set -e

if [[ -z "$1" ]]; then
  echo "usage: svg_validate.sh <file.svg>" >&2
  exit 2
fi
FILE="$1"

if [[ ! -f "$FILE" ]]; then
  echo "not found: $FILE" >&2
  exit 2
fi

issues=0

# 1. Well-formed XML
if ! xmllint --noout "$FILE" 2>/tmp/svg_val.err; then
  echo "XML is not well-formed:"
  sed 's/^/  /' /tmp/svg_val.err
  issues=$((issues + 1))
fi

# 2. Must have a viewBox (or width/height) — missing both is how designs render differently in every viewer
if ! grep -qE 'viewBox=' "$FILE"; then
  if ! grep -qE 'width=.*height=' "$FILE"; then
    echo "missing viewBox AND width/height — output will render inconsistently"
    issues=$((issues + 1))
  else
    echo "no viewBox — fine for fixed-size render, but add one if this will ever scale"
  fi
fi

# 3. External references — rsvg-convert won't fetch these during render
if grep -qE 'href="https?://' "$FILE"; then
  echo "external href found — rsvg-convert will not fetch it at render time"
  issues=$((issues + 1))
fi

# 4. NaN or infinity sneaked in from a bad calc
if grep -qE '\b(NaN|Infinity|-Infinity)\b' "$FILE"; then
  echo "found NaN / Infinity values — check your last transform edit"
  issues=$((issues + 1))
fi

# 5. <foreignObject> — rarely survives raster rendering
if grep -q '<foreignObject' "$FILE"; then
  echo "foreignObject present — rsvg-convert may drop its contents"
fi

# 6. Duplicate IDs — breaks textPath / clipPath / use references
dup=$(grep -oE 'id="[^"]+"' "$FILE" | sort | uniq -d | head -5)
if [[ -n "$dup" ]]; then
  echo "duplicate IDs (will break textPath/use):"
  echo "$dup" | sed 's/^/  /'
  issues=$((issues + 1))
fi

if [[ $issues -eq 0 ]]; then
  echo "OK  $FILE"
  exit 0
fi
exit 1
