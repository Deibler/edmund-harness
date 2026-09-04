#!/bin/bash
# Self-locating launchd wrapper: resolve the repo root from this script's own
# path (scripts/launchd/ -> repo root) so a fresh checkout works on any machine
# without hardcoded home paths. bun is resolved via PATH with a Homebrew fallback.
cd "$(dirname "$0")/../.." || exit 1

# Machine-local environment (LAN addresses, host overrides for skills, etc.).
# Gitignored, so per-machine topology never lands in the repo. Optional.
if [ -r .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi

BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
exec "$BUN" src/main.ts
