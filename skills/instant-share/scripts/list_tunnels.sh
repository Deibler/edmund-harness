#!/bin/bash
# List all active instant-share tunnels
# Usage: list_tunnels.sh [--json]

CONFIG_DIR="${INSTANT_SHARE_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.config}"
TUNNELS_DIR="${CONFIG_DIR}/tunnels"
LEGACY_STATE="${CONFIG_DIR}/active_tunnel.state"
JSON_MODE=false

[[ "$1" == "--json" ]] && JSON_MODE=true

check_alive() {
    local pid="$1"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

print_tunnel() {
    local state_file="$1"
    [[ -f "$state_file" ]] || return
    
    # Source in subshell to avoid variable pollution
    local SERVER_PID TUNNEL_PID TOKEN ARTIFACT_ID ARTIFACT_PATH SECURE_URL ADMIN_URL STARTED EXPIRE_MINUTES
    source "$state_file"
    
    local server_alive="dead"
    local tunnel_alive="dead"
    check_alive "$SERVER_PID" && server_alive="running"
    check_alive "$TUNNEL_PID" && tunnel_alive="running"
    
    local status="dead"
    [[ "$server_alive" == "running" && "$tunnel_alive" == "running" ]] && status="live"
    
    if $JSON_MODE; then
        echo "{\"id\":\"$ARTIFACT_ID\",\"url\":\"$SECURE_URL\",\"status\":\"$status\",\"started\":\"$STARTED\",\"expires\":\"${EXPIRE_MINUTES}m\",\"path\":\"$ARTIFACT_PATH\"}"
    else
        # Get artifact name if available
        local name=""
        if [[ -f "$ARTIFACT_PATH/artifact.json" ]]; then
            name=$(jq -r '.name // empty' "$ARTIFACT_PATH/artifact.json" 2>/dev/null)
        fi
        
        echo "  ${name:-$ARTIFACT_ID}"
        echo "    Status:  $status (server: $server_alive, tunnel: $tunnel_alive)"
        echo "    URL:     $SECURE_URL"
        echo "    Path:    $ARTIFACT_PATH"
        echo "    Started: $STARTED"
        echo "    Expires: ${EXPIRE_MINUTES} minutes"
        echo ""
    fi
}

count=0

if $JSON_MODE; then
    echo "["
fi

# Check new multi-tunnel state
if [[ -d "$TUNNELS_DIR" ]]; then
    for sf in "$TUNNELS_DIR"/*.state; do
        [[ -f "$sf" ]] || continue
        [[ $count -gt 0 ]] && $JSON_MODE && echo ","
        print_tunnel "$sf"
        count=$((count + 1))
    done
fi

# Check legacy state if no tunnels dir entries found
if [[ $count -eq 0 && -f "$LEGACY_STATE" ]]; then
    print_tunnel "$LEGACY_STATE"
    count=$((count + 1))
fi

if $JSON_MODE; then
    echo "]"
else
    if [[ $count -eq 0 ]]; then
        echo "No active tunnels."
    else
        echo "Total: $count tunnel(s)"
    fi
fi
