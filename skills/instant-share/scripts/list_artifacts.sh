#!/bin/bash
# List all artifacts with their manifest info
# Usage: list_artifacts.sh [--json]

set -e

CONFIG_DIR="${INSTANT_SHARE_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.config}"
ARTIFACT_BASE="${INSTANT_SHARE_ARTIFACT_DIR:-/tmp}"
JSON_OUTPUT=false

[[ "$1" == "--json" ]] && JSON_OUTPUT=true

# Find all artifact directories
ARTIFACTS=()
for dir in "${ARTIFACT_BASE}"/artifact_*; do
    [[ -d "$dir" && -f "$dir/artifact.json" ]] && ARTIFACTS+=("$dir")
done

if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
    if $JSON_OUTPUT; then
        echo "[]"
    else
        echo "No artifacts found."
    fi
    exit 0
fi

if $JSON_OUTPUT; then
    echo "["
    first=true
    for dir in "${ARTIFACTS[@]}"; do
        $first || echo ","
        first=false
        cat "$dir/artifact.json"
    done
    echo "]"
else
    echo "==========================================================="
    echo "Artifacts"
    echo "==========================================================="
    echo ""

    for dir in "${ARTIFACTS[@]}"; do
        manifest="$dir/artifact.json"
        name=$(jq -r '.name // "Unnamed"' "$manifest" 2>/dev/null || echo "Unnamed")
        purpose=$(jq -r '.purpose // "No purpose"' "$manifest" 2>/dev/null || echo "")
        created=$(jq -r '.created_at // "Unknown"' "$manifest" 2>/dev/null || echo "Unknown")
        status=$(jq -r '.status // "unknown"' "$manifest" 2>/dev/null || echo "unknown")
        group=$(jq -r '.group_chat_id // ""' "$manifest" 2>/dev/null || echo "")

        # Check if _status file exists (building)
        [[ -f "$dir/_status" ]] && status="building"

        echo "$name"
        echo "   Path: $dir"
        echo "   Purpose: ${purpose:-Not specified}"
        echo "   Created: $created"
        echo "   Status: $status"
        [[ -n "$group" ]] && echo "   Group: $group"
        echo ""
    done
fi
