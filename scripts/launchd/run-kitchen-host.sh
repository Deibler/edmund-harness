#!/bin/bash
# The kitchen host: every household's site at its permanent address, with the
# named tunnel that publishes it. See integrations/kitchen/src/host.ts.
cd "$(dirname "$0")/../.." || exit 1
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
exec "$BUN" integrations/kitchen/scripts/host.ts
