#!/bin/bash
# Set up the STANDING cloudflared tunnel for the user portal.
#
# Exposes ONLY the public-only listener (127.0.0.1:4749 — token-gated
# /u portal + /a annotate, 404 for everything else). The PIN dashboard on
# :4747 is NOT reachable through this tunnel.
#
# Prereq (one-time, interactive): cloudflared tunnel login
# Usage:   ./scripts/setup-portal-tunnel.sh edmund.example.com
#
# What it does:
#   1. cloudflared tunnel create edmund-portal     (idempotent)
#   2. cloudflared tunnel route dns … <hostname>   (CNAME on your zone)
#   3. writes ~/.cloudflared/edmund-portal.yml     (ingress → 127.0.0.1:4749)
#   4. installs + loads launchd service com.edmund-harness.portal-tunnel
#   5. prints the config.toml change to make ([dashboard] external_url)
set -euo pipefail

HOSTNAME="${1:-}"
[ -z "$HOSTNAME" ] && { echo "usage: $0 <hostname e.g. edmund.yourdomain.com>"; exit 2; }

TUNNEL_NAME="edmund-portal"
PUBLIC_PORT="${2:-4749}"
CLOUDFLARED="$(command -v cloudflared)"
CFDIR="$HOME/.cloudflared"
PLIST="$HOME/Library/LaunchAgents/com.edmund-harness.portal-tunnel.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$CFDIR/cert.pem" ] || { echo "ERROR: no $CFDIR/cert.pem — run 'cloudflared tunnel login' first (one-time browser auth)."; exit 1; }

# 1. Create (or reuse) the named tunnel.
if ! "$CLOUDFLARED" tunnel list 2>/dev/null | grep -q " $TUNNEL_NAME "; then
  "$CLOUDFLARED" tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID=$("$CLOUDFLARED" tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}')
[ -z "$TUNNEL_ID" ] && { echo "ERROR: could not resolve tunnel id"; exit 1; }
echo "tunnel: $TUNNEL_NAME ($TUNNEL_ID)"

# 2. DNS route (CNAME hostname → tunnel). Idempotent-ish; ignore exists-error.
"$CLOUDFLARED" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || true

# 3. Ingress config — hostname → the public-only listener; everything else 404.
cat > "$CFDIR/$TUNNEL_NAME.yml" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CFDIR/$TUNNEL_ID.json
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:$PUBLIC_PORT
  - service: http_status:404
EOF
echo "wrote $CFDIR/$TUNNEL_NAME.yml"

# 4. launchd service — survives reboots, restarts on crash.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.edmund-harness.portal-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>$CLOUDFLARED</string>
        <string>tunnel</string>
        <string>--config</string>
        <string>$CFDIR/$TUNNEL_NAME.yml</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$REPO/data/portal-tunnel.out.log</string>
    <key>StandardErrorPath</key><string>$REPO/data/portal-tunnel.err.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/com.edmund-harness.portal-tunnel" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "launchd service com.edmund-harness.portal-tunnel loaded"

echo ""
echo "DONE. Final step — point the harness at the public host:"
echo "  config.toml → [dashboard] external_url = \"https://$HOSTNAME\""
echo "  then restart: launchctl kickstart -k gui/\$(id -u)/com.edmund-harness{,.dashboard}"
