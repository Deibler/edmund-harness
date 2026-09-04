#!/bin/bash
# Pre-flight validation for artifacts
# Returns 0 if valid, 1 if invalid
# Prints errors to stderr

set -e

ARTIFACT_PATH="$1"
ERRORS=0

error() {
    echo "ERROR: $1" >&2
    ERRORS=$((ERRORS + 1))
}

warn() {
    echo "WARNING: $1" >&2
}

if [[ -z "$ARTIFACT_PATH" ]]; then
    echo "Usage: validate_artifact.sh <artifact_path>" >&2
    exit 1
fi

if [[ ! -d "$ARTIFACT_PATH" ]]; then
    error "Path is not a directory: $ARTIFACT_PATH"
    exit 1
fi

echo "Validating artifact: $ARTIFACT_PATH" >&2

# Check 1: artifact.json must exist
if [[ ! -f "$ARTIFACT_PATH/artifact.json" ]]; then
    error "Missing artifact.json - use create_artifact.sh to create artifacts"
else
    # Check required fields in artifact.json
    MANIFEST=$(cat "$ARTIFACT_PATH/artifact.json")
    
    NAME=$(echo "$MANIFEST" | jq -r '.name // empty')
    if [[ -z "$NAME" ]]; then
        error "artifact.json missing 'name' field"
    fi
    
    PURPOSE=$(echo "$MANIFEST" | jq -r '.purpose // empty')
    if [[ -z "$PURPOSE" ]]; then
        warn "artifact.json missing 'purpose' field (recommended)"
    fi
    
    echo "  Name: $NAME" >&2
    echo "  Purpose: ${PURPOSE:-Not specified}" >&2
fi

# Check 2: index.html must exist
if [[ ! -f "$ARTIFACT_PATH/index.html" ]]; then
    error "Missing index.html"
fi

# Check 3: Design guideline validation
if [[ -f "$ARTIFACT_PATH/index.html" ]]; then
    HTML_CONTENT=$(cat "$ARTIFACT_PATH/index.html")

    # Check for emojis (common emoji unicode ranges)
    if echo "$HTML_CONTENT" | grep -qP '[\x{1F300}-\x{1F9FF}]|[\x{2600}-\x{26FF}]|[\x{2700}-\x{27BF}]' 2>/dev/null; then
        error "Design violation: Contains emojis (banned)"
    fi

    # Check for purple colors
    if echo "$HTML_CONTENT" | grep -qiE '#(800080|663399|9b59b6|8e44ad|9c27b0|7b1fa2|6a1b9a|4a148c|purple)' 2>/dev/null; then
        error "Design violation: Contains purple colors (banned)"
    fi

    # Check for gradients
    if echo "$HTML_CONTENT" | grep -qiE '(linear-gradient|radial-gradient|conic-gradient)' 2>/dev/null; then
        error "Design violation: Contains gradients (banned)"
    fi

    # Check for viewport meta tag
    if ! echo "$HTML_CONTENT" | grep -qi 'viewport' 2>/dev/null; then
        warn "Missing viewport meta tag (recommended for mobile)"
    fi

    # Check for admin link compatibility (needs {{ADMIN_URL}} OR </body> for auto-injection)
    if ! echo "$HTML_CONTENT" | grep -q '{{ADMIN_URL}}' 2>/dev/null; then
        if ! echo "$HTML_CONTENT" | grep -q '</body>' 2>/dev/null; then
            error "Admin link cannot be injected: Missing both {{ADMIN_URL}} placeholder and </body> tag"
        else
            echo "  Admin link: Will be auto-injected before </body>" >&2
        fi
    else
        echo "  Admin link: {{ADMIN_URL}} placeholder found" >&2
    fi
fi

# Summary
echo "" >&2
if [[ $ERRORS -gt 0 ]]; then
    echo "VALIDATION FAILED: $ERRORS error(s)" >&2
    echo "" >&2
    echo "Fix errors before sharing. Use create_artifact.sh for proper setup." >&2
    exit 1
else
    echo "VALIDATION PASSED" >&2
    exit 0
fi
