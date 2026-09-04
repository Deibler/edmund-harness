#!/bin/bash
# Mark an artifact as ready (removes building status)
# Usage: mark_ready.sh <artifact_directory>
#
# This causes the loading page to stop showing and serve the actual content.
# The next page refresh will show the artifact.

set -e

if [[ -z "$1" ]]; then
    echo "Usage: mark_ready.sh <artifact_directory>" >&2
    exit 1
fi

ARTIFACT_DIR="$1"

if [[ ! -d "$ARTIFACT_DIR" ]]; then
    echo "Error: Directory not found: $ARTIFACT_DIR" >&2
    exit 1
fi

STATUS_FILE="${ARTIFACT_DIR}/_status"

# Remove status file to mark as ready
if [[ -f "$STATUS_FILE" ]]; then
    rm -f "$STATUS_FILE"
    echo "✓ Artifact marked as ready: $ARTIFACT_DIR"
else
    echo "✓ Artifact already ready: $ARTIFACT_DIR"
fi

# Verify index.html exists
if [[ ! -f "${ARTIFACT_DIR}/index.html" ]]; then
    echo "⚠ Warning: No index.html found in artifact directory" >&2
fi
