#!/bin/bash
# Self-locating launchd wrapper: resolve the repo root from this script's own
# path (scripts/launchd/ -> repo root) so a fresh checkout works on any machine
# without hardcoded home paths. bun is resolved via PATH with a Homebrew fallback.
cd "$(dirname "$0")/../.." || exit 1
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
exec "$BUN" dashboard/server/main.ts
