#!/bin/bash
# Create a secure, isolated artifact directory with manifest
# Usage: create_artifact.sh [options]
#
# Options:
#   --name "Name"           Artifact name
#   --purpose "Purpose"     Purpose/intent description  
#   --description "Desc"    Detailed description
#   --group-chat "id:15"    Group chat ID
#   --ready                 Start in ready state (no loading page)
#   --expire MINUTES        Auto-expire after N minutes

set -e

CONFIG_DIR="${INSTANT_SHARE_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.config}"
ARTIFACT_BASE="${INSTANT_SHARE_ARTIFACT_DIR:-/tmp}"

NAME="Untitled Artifact"
PURPOSE=""
DESCRIPTION=""
GROUP_CHAT=""
START_READY=false
EXPIRE_MINUTES=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --name) NAME="$2"; shift 2 ;;
        --purpose) PURPOSE="$2"; shift 2 ;;
        --description) DESCRIPTION="$2"; shift 2 ;;
        --group-chat) GROUP_CHAT="$2"; shift 2 ;;
        --ready) START_READY=true; shift ;;
        --expire) EXPIRE_MINUTES="$2"; shift 2 ;;
        *) shift ;;
    esac
done

ARTIFACT_ID="artifact_$(openssl rand -hex 8)"
ARTIFACT_DIR="${ARTIFACT_BASE}/${ARTIFACT_ID}"
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$ARTIFACT_DIR"
chmod 700 "$ARTIFACT_DIR"

if [[ "$START_READY" != "true" ]]; then
    echo "building" > "${ARTIFACT_DIR}/_status"
fi

# Create artifact.json manifest
cat > "${ARTIFACT_DIR}/artifact.json" << EOF
{
  "name": "$NAME",
  "description": "$DESCRIPTION",
  "purpose": "$PURPOSE",
  "artifact_id": "$ARTIFACT_ID",
  "created_at": "$CREATED_AT",
  "updated_at": "$CREATED_AT",
  "group_chat_id": "$GROUP_CHAT",
  "expire_minutes": ${EXPIRE_MINUTES:-null},
  "status": "$([ "$START_READY" = "true" ] && echo "ready" || echo "building")",
  "version": 1
}
EOF
chmod 600 "${ARTIFACT_DIR}/artifact.json"

# Clean default template - no emojis, no gradients, no purple
cat > "${ARTIFACT_DIR}/index.html" << 'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Artifact</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #fafafa;
            color: #111;
            padding: 24px;
            max-width: 800px;
            margin: 0 auto;
            line-height: 1.6;
        }
        h1 { font-size: 24px; font-weight: 600; margin-bottom: 16px; }
        p { color: #666; margin-bottom: 12px; }
        img, video, iframe { max-width: 100%; height: auto; }
        code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
        pre { background: #f0f0f0; padding: 16px; border-radius: 4px; overflow-x: auto; }
        footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #999; text-align: center; }
        footer a { color: #999; text-decoration: none; }
        footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h1>Artifact</h1>
    <p>Replace this content with your artifact.</p>
    {{#ADMIN_URL}}<footer><a href="{{ADMIN_URL}}">Admin</a></footer>{{/ADMIN_URL}}
</body>
</html>
HTML

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
echo "${ARTIFACT_DIR}" >> "${CONFIG_DIR}/artifacts.list"

echo "$ARTIFACT_DIR"
