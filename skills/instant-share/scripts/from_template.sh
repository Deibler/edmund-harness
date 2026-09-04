#!/usr/bin/env bash
# Generate artifact from template with variable substitution
# Usage: from_template.sh --template <name> --var KEY=VALUE [--var KEY2=VALUE2] [--output <path>]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$SKILL_DIR/templates"

# Defaults
TEMPLATE=""
OUTPUT=""
VAR_KEYS=""
VAR_COUNT=0
ARTIFACT_NAME=""
ARTIFACT_PURPOSE=""

usage() {
    cat << EOF
Usage: $(basename "$0") --template <name> [options]

Templates:
  research-report   Academic/business research report with sections
  file-download     Simple file download page
  blog              Blog post with author, date, content
  news-article      News article with byline, lead, sections

Options:
  --template, -t    Template name (required)
  --var, -v         Set variable: KEY=VALUE (repeatable)
  --name, -n        Artifact name (for artifact.json)
  --purpose, -p     Artifact purpose (for artifact.json)
  --output, -o      Output file path (default: creates artifact)
  --list            List available templates
  --show            Show template variables

Examples:
  # Create research report
  $(basename "$0") -t research-report \\
    -v TITLE="Market Analysis" \\
    -v AUTHOR="Edmund" \\
    -v DATE="Feb 2026" \\
    -v EXECUTIVE_SUMMARY="Key findings from Q1..."

  # Create file download page
  $(basename "$0") -t file-download \\
    -v FILENAME="report.pdf" \\
    -v FILE_SIZE="2.4 MB" \\
    -v DOWNLOAD_URL="./report.pdf"

  # See all variables for a template
  $(basename "$0") -t blog --show
EOF
    exit 1
}

list_templates() {
    echo "Available templates:"
    echo ""
    for f in "$TEMPLATE_DIR"/*.html; do
        if [[ -f "$f" ]]; then
            name=$(basename "$f" .html)
            echo "  $name"
        fi
    done
    echo ""
    echo "Use --show to see variables for a template"
    exit 0
}

show_template_vars() {
    local template_file="$TEMPLATE_DIR/$TEMPLATE.html"
    if [[ ! -f "$template_file" ]]; then
        echo "Template not found: $TEMPLATE"
        exit 1
    fi
    
    echo "Variables for '$TEMPLATE' template:"
    echo ""
    
    # Extract {{VAR}} patterns, excluding conditional markers
    grep -oE '\{\{[A-Z_]+\}\}' "$template_file" | \
        sed 's/{{//g; s/}}//g' | \
        grep -v '^#' | \
        grep -v '^/' | \
        sort -u | \
        while read var; do
            echo "  $var"
        done
    
    echo ""
    echo "Conditional sections ({{#VAR}}...{{/VAR}}):"
    grep -oE '\{\{#[A-Z_]+\}\}' "$template_file" 2>/dev/null | \
        sed 's/{{#//g; s/}}//g' | \
        sort -u | \
        while read var; do
            echo "  $var (optional)"
        done
    exit 0
}

# Store variable in temp file (portable approach)
VARS_FILE=$(mktemp)
trap "rm -f $VARS_FILE" EXIT

set_var() {
    echo "$1=$2" >> "$VARS_FILE"
}

get_var() {
    grep "^$1=" "$VARS_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --template|-t)
            TEMPLATE="$2"
            shift 2
            ;;
        --var|-v)
            key="${2%%=*}"
            value="${2#*=}"
            set_var "$key" "$value"
            shift 2
            ;;
        --output|-o)
            OUTPUT="$2"
            shift 2
            ;;
        --name|-n)
            ARTIFACT_NAME="$2"
            shift 2
            ;;
        --purpose|-p)
            ARTIFACT_PURPOSE="$2"
            shift 2
            ;;
        --list)
            list_templates
            ;;
        --show)
            if [[ -z "$TEMPLATE" ]]; then
                echo "Error: --template required with --show"
                exit 1
            fi
            show_template_vars
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Validate
if [[ -z "$TEMPLATE" ]]; then
    echo "Error: --template is required"
    usage
fi

TEMPLATE_FILE="$TEMPLATE_DIR/$TEMPLATE.html"
if [[ ! -f "$TEMPLATE_FILE" ]]; then
    echo "Template not found: $TEMPLATE"
    echo "Available: $(ls "$TEMPLATE_DIR" | sed 's/\.html//g' | tr '\n' ' ')"
    exit 1
fi

# Set default output
ARTIFACT=""
if [[ -z "$OUTPUT" ]]; then
    # Create artifact directory with proper metadata
    CREATE_ARGS=()
    if [[ -n "$ARTIFACT_NAME" ]]; then
        CREATE_ARGS+=(--name "$ARTIFACT_NAME")
    else
        CREATE_ARGS+=(--name "$TEMPLATE artifact")
    fi
    if [[ -n "$ARTIFACT_PURPOSE" ]]; then
        CREATE_ARGS+=(--purpose "$ARTIFACT_PURPOSE")
    fi
    
    ARTIFACT=$("$SCRIPT_DIR/create_artifact.sh" "${CREATE_ARGS[@]}")
    OUTPUT="$ARTIFACT/index.html"
    echo "Created artifact: $ARTIFACT" >&2
fi

# Read template
content=$(cat "$TEMPLATE_FILE")

# Add auto-generated date if not provided
if [[ -z "$(get_var GENERATED_DATE)" ]]; then
    set_var "GENERATED_DATE" "$(date '+%B %d, %Y at %H:%M')"
fi

# Get all variable keys
VAR_KEYS=$(cut -d= -f1 "$VARS_FILE" | sort -u)

# Process conditional sections {{#VAR}}...{{/VAR}}
for key in $VAR_KEYS; do
    value=$(get_var "$key")
    if [[ -n "$value" ]]; then
        # Remove conditional markers but keep content
        content=$(echo "$content" | sed "s/{{#$key}}//g; s/{{\\/$key}}//g")
    fi
done

# Remove any remaining conditional sections (for unset vars)
# EXCEPT for ADMIN_URL which is injected later by share.sh
content=$(echo "$content" | perl -0777 -pe 's/\{\{#(?!ADMIN_URL)[A-Z_]+\}\}.*?\{\{\/(?!ADMIN_URL)[A-Z_]+\}\}//gs')

# Replace variables
for key in $VAR_KEYS; do
    value=$(get_var "$key")
    # Write to temp file and read back to preserve newlines
    TEMP_VAL=$(mktemp)
    echo "$value" > "$TEMP_VAL"
    # Use perl for replacement to handle special characters
    content=$(echo "$content" | perl -pe "
        BEGIN { 
            open(F, '<', '$TEMP_VAL'); 
            \$val = do { local \$/; <F> }; 
            close(F); 
            chomp \$val;
        }
        s/\{\{$key\}\}/\$val/g;
    ")
    rm -f "$TEMP_VAL"
done

# Write output
mkdir -p "$(dirname "$OUTPUT")"
echo "$content" > "$OUTPUT"

echo "Generated: $OUTPUT" >&2

# Output artifact path if we created one (for capturing in scripts)
if [[ -n "$ARTIFACT" ]]; then
    echo "$ARTIFACT"
fi
