#!/bin/bash
# Named-tunnel runner for the SMS webhook (launchd-managed).
#
# Runs the `edmund-sms` Cloudflare tunnel (<tunnel-uuid>),
# whose cloud-managed ingress maps https://sms.example.com to
# http://127.0.0.1:4790 — the daemon's signature-gated /sms routes and nothing
# else. The hostname is permanent: unlike a quick tunnel there is no URL churn,
# so Twilio's webhook config and the daemon's signature validation both pin to
# config.toml's [sms].public_base_url and never need healing.
#
# The token in data/sms-tunnel-token (mode 600, gitignored) only authorizes
# RUNNING this one tunnel — it cannot reconfigure it or touch the account.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
exec /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run \
  --token-file "$REPO/data/sms-tunnel-token" \
  >> "$REPO/data/sms-tunnel.log" 2>&1
