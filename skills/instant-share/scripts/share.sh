#!/bin/bash
# instant-share: Share artifacts via authenticated Cloudflare tunnel
#
# CRITICAL: URL is verified working before being returned.
# Never outputs a dead link.
#
# Usage: share.sh <file|directory> [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${INSTANT_SHARE_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.config}"
BACKGROUND=true
EXPIRE_MINUTES=60
INPUT=""
HTML_CONTENT=""
MAX_VERIFY_ATTEMPTS=10
VERIFY_DELAY=2

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

while [[ $# -gt 0 ]]; do
    case $1 in
        --background) BACKGROUND=true; shift ;;
        --foreground) BACKGROUND=false; shift ;;
        --expire) EXPIRE_MINUTES="$2"; shift 2 ;;
        --html) HTML_CONTENT="$2"; shift 2 ;;
        -h|--help)
            cat << 'EOF'
Usage: share.sh <file|directory> [options]

Options:
  --background     Run in background (default)
  --foreground     Keep the tunnel attached to this terminal
  --expire MIN     Auto-expire (default: 60 min)
  --html "..."     Share inline HTML

URL is verified working before being returned.
EOF
            exit 0
            ;;
        *) INPUT="$1"; shift ;;
    esac
done

command -v cloudflared &>/dev/null || { echo "Error: cloudflared not found" >&2; exit 1; }
command -v python3 &>/dev/null || { echo "Error: python3 not found" >&2; exit 1; }
command -v curl &>/dev/null || { echo "Error: curl not found" >&2; exit 1; }

# Every share creation is also a cheap recovery point for a daemon that was
# previously killed before its periodic lease reaper ran.
python3 "$SCRIPT_DIR/reap.py" --config-dir "$CONFIG_DIR" >/dev/null 2>&1 || true

SERVE_PATH=""
TEMP_ARTIFACT=""
SKIP_VALIDATION=false

if [[ -n "$HTML_CONTENT" ]]; then
    TEMP_ARTIFACT=$("$SCRIPT_DIR/create_artifact.sh" --ready --name "Inline HTML" --purpose "Quick share")
    echo "$HTML_CONTENT" > "${TEMP_ARTIFACT}/index.html"
    SERVE_PATH="$TEMP_ARTIFACT"
elif [[ "$INPUT" == "-" ]]; then
    TEMP_ARTIFACT=$("$SCRIPT_DIR/create_artifact.sh" --ready --name "Stdin HTML" --purpose "Quick share")
    cat > "${TEMP_ARTIFACT}/index.html"
    SERVE_PATH="$TEMP_ARTIFACT"
elif [[ -f "$INPUT" ]]; then
    SERVE_PATH="$(realpath "$INPUT")"
elif [[ -d "$INPUT" ]]; then
    SERVE_PATH="$(realpath "$INPUT")"
    
    # MANDATORY: Validate artifact before sharing
    if ! "$SCRIPT_DIR/validate_artifact.sh" "$SERVE_PATH"; then
        echo "" >&2
        echo "BLOCKED: Artifact failed validation. Fix errors before sharing." >&2
        echo "See: skills/instant-share/references/DESIGN.md (relative to harness root)" >&2
        exit 1
    fi
    
    if [[ -f "$SERVE_PATH/artifact.json" ]]; then
        TMP=$(mktemp)
        jq --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_served = $time' "$SERVE_PATH/artifact.json" > "$TMP" && mv "$TMP" "$SERVE_PATH/artifact.json"
    fi
else
    echo "Error: Provide a file, directory, or --html content" >&2
    exit 1
fi

cleanup() {
    if [[ "$BACKGROUND" != "true" ]]; then
        [[ -n "$TEMP_ARTIFACT" && -d "$TEMP_ARTIFACT" ]] && rm -rf "$TEMP_ARTIFACT"
    fi
    [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
    [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
    rm -f "$SERVER_LOG" "$TUNNEL_LOG" 2>/dev/null || true
}
trap cleanup EXIT

# Start server
SERVER_LOG=$(mktemp)
python3 "$SCRIPT_DIR/secure_server.py" "$SERVE_PATH" 0 "$EXPIRE_MINUTES" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for i in {1..50}; do
    sleep 0.1
    grep -q "SERVER_READY" "$SERVER_LOG" 2>/dev/null && break
    kill -0 $SERVER_PID 2>/dev/null || { echo "Error: Server failed to start" >&2; cat "$SERVER_LOG" >&2; exit 1; }
done

PORT=$(grep "^PORT=" "$SERVER_LOG" | cut -d= -f2)
TOKEN=$(grep "^TOKEN=" "$SERVER_LOG" | cut -d= -f2)
ARTIFACT_ID=$(grep "^ARTIFACT_ID=" "$SERVER_LOG" | cut -d= -f2)

[[ -z "$PORT" || -z "$TOKEN" ]] && { echo "Error: Failed to get server config" >&2; exit 1; }

# Verify local server is responding
LOCAL_URL="http://127.0.0.1:$PORT/?key=$TOKEN"
LOCAL_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL_URL" 2>/dev/null || echo "000")
if [[ "$LOCAL_STATUS" != "200" && "$LOCAL_STATUS" != "403" ]]; then
    echo "Error: Local server not responding (status: $LOCAL_STATUS)" >&2
    exit 1
fi

# Start tunnel
TUNNEL_LOG=$(mktemp)

if $BACKGROUND; then
    nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    
    # Wait for tunnel URL to appear
    TUNNEL_URL=""
    echo "Establishing tunnel..." >&2
    for i in {1..60}; do
        sleep 0.5
        TUNNEL_URL=$(grep -o 'https://[^[:space:]]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
        [[ -n "$TUNNEL_URL" ]] && break
    done
    
    if [[ -z "$TUNNEL_URL" ]]; then
        echo "Error: Failed to establish tunnel" >&2
        kill $TUNNEL_PID 2>/dev/null || true
        exit 1
    fi
    
    SECURE_URL="${TUNNEL_URL}/?key=${TOKEN}"
    ADMIN_URL="${TUNNEL_URL}/admin/?key=${TOKEN}"
    
    # Wait for tunnel to fully establish before verification
    echo "Waiting for tunnel to stabilize..." >&2
    sleep 5
    
    # CRITICAL: Verify the public URL is actually working
    echo "Verifying URL is live..." >&2
    VERIFIED=false
    for attempt in $(seq 1 $MAX_VERIFY_ATTEMPTS); do
        sleep $VERIFY_DELAY
        
        # Test the URL
        HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SECURE_URL" 2>/dev/null || echo "000")
        
        if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "403" ]]; then
            # 200 = content served, 403 = auth working (both mean tunnel is up)
            # For our URLs with valid token, we expect 200
            if [[ "$HTTP_STATUS" == "200" ]]; then
                VERIFIED=true
                echo "Verified: URL responding with status $HTTP_STATUS" >&2
                break
            fi
        fi
        
        echo "Attempt $attempt/$MAX_VERIFY_ATTEMPTS: status $HTTP_STATUS, retrying..." >&2
        
        # Check if tunnel process is still running
        if ! kill -0 $TUNNEL_PID 2>/dev/null; then
            echo "Error: Tunnel process died" >&2
            exit 1
        fi
    done
    
    if [[ "$VERIFIED" != "true" ]]; then
        echo "Error: Could not verify URL is working after $MAX_VERIFY_ATTEMPTS attempts" >&2
        echo "Last status: $HTTP_STATUS" >&2
        kill $TUNNEL_PID 2>/dev/null || true
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
    
    # Save state - per-tunnel (supports multiple concurrent tunnels)
    TUNNELS_DIR="${CONFIG_DIR}/tunnels"
    mkdir -p "$TUNNELS_DIR"
    chmod 700 "$TUNNELS_DIR"
    
    TUNNEL_STATE_FILE="${TUNNELS_DIR}/${ARTIFACT_ID:-tunnel_$$}.state"
    cat > "$TUNNEL_STATE_FILE" << EOF
SERVER_PID=$SERVER_PID
TUNNEL_PID=$TUNNEL_PID
TOKEN=$TOKEN
ARTIFACT_ID=$ARTIFACT_ID
ARTIFACT_PATH=$SERVE_PATH
TEMP_ARTIFACT=$TEMP_ARTIFACT
PORT=$PORT
EXPIRE_MINUTES=$EXPIRE_MINUTES
SECURE_URL=$SECURE_URL
ADMIN_URL=$ADMIN_URL
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERIFIED=true
EOF

    # Also write legacy state for backward compat (latest tunnel)
    cp "$TUNNEL_STATE_FILE" "${CONFIG_DIR}/active_tunnel.state"
    echo "$SECURE_URL" > "${CONFIG_DIR}/active_tunnel.url"
    
    # Update manifest
    if [[ -f "$SERVE_PATH/artifact.json" ]]; then
        TMP=$(mktemp)
        jq --arg url "$SECURE_URL" --arg admin "$ADMIN_URL" '.public_url = $url | .admin_url = $admin | .verified = true' "$SERVE_PATH/artifact.json" > "$TMP" && mv "$TMP" "$SERVE_PATH/artifact.json" 2>/dev/null || true
    fi
    
    # Admin link is now injected dynamically by secure_server.py at serve time.
    # This ensures the admin footer persists even when HTML files are edited after sharing.
    # Template placeholder {{ADMIN_URL}} replacement is also handled by the server.
    
    # Output verified URLs
    echo ""
    echo "============================================================"
    echo "VERIFIED LIVE URL:"
    echo ""
    echo "   $SECURE_URL"
    echo ""
    echo "============================================================"
    echo ""
    echo "Admin: ${ADMIN_URL}"
    echo "Password: (set via INSTANT_SHARE_ADMIN_PASSWORD / [instant_share].admin_password)"
    echo ""
    echo "Expires in: ${EXPIRE_MINUTES} minutes"
    echo "Status: Verified working"
    echo ""
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo "Commands:"
    echo "   Mark ready: $SCRIPT_DIR/mark_ready.sh $SERVE_PATH"
    echo "   Stop:       $SCRIPT_DIR/stop.sh"
    echo "   Verify:     $SCRIPT_DIR/verify.sh"
    echo ""
    
    trap - EXIT
else
    # Foreground mode
    cloudflared tunnel --url "http://127.0.0.1:$PORT" 2>&1 | while IFS= read -r line; do
        echo "$line"
        if [[ "$line" == *"trycloudflare.com"* ]]; then
            TUNNEL_URL=$(echo "$line" | grep -o 'https://[^[:space:]]*\.trycloudflare\.com' || true)
            if [[ -n "$TUNNEL_URL" ]]; then
                SECURE_URL="${TUNNEL_URL}/?key=${TOKEN}"
                
                # Verify before showing
                sleep 3
                HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SECURE_URL" 2>/dev/null || echo "000")
                
                if [[ "$HTTP_STATUS" == "200" ]]; then
                    echo ""
                    echo "============================================================"
                    echo "VERIFIED URL: $SECURE_URL"
                    echo "Admin: ${TUNNEL_URL}/admin/?key=${TOKEN}"
                    echo "Status: Verified (HTTP $HTTP_STATUS)"
                    echo "============================================================"
                else
                    echo ""
                    echo "WARNING: URL may not be ready (HTTP $HTTP_STATUS)"
                    echo "URL: $SECURE_URL"
                fi
            fi
        fi
    done
fi
