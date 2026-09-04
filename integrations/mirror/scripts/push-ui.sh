#!/usr/bin/env bash
# Put a freshly built mirror-ui on the Pi now, without waiting for a release.
#
# The normal path is commit -> CI -> tagged release -> the node's update timer,
# which is minutes. That is correct for shipping and useless for judging a
# 2 px change on glass, so this patches the running node directly.
#
# Two destinations on purpose. `current` is the release tree the daemon
# actually serves; `~/constellation` is the checkout the updater builds the
# next release from. Patching only the first means the change survives until
# the next activation and then silently disappears mid-session, which is
# indistinguishable from "the CSS didn't work".
#
# This is a TEST path. The committed source is still the source of truth — the
# release that lands later must contain the same build, or the node quietly
# diverges from every other one.
set -euo pipefail

REPO=${CONSTELLATION_REPO:?set CONSTELLATION_REPO to your constellation checkout}
PI_HOST=${MIRROR_PI_HOST:?set MIRROR_PI_HOST to user@host of the mirror Pi}
PI_PASS=${MIRROR_PI_PASS:?set MIRROR_PI_PASS (never commit a value for it)}
CURRENT=/home/${MIRROR_PI_USER:-pi}/.local/share/constellation/current
CHECKOUT=/home/${MIRROR_PI_USER:-pi}/constellation

pi() { sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "$PI_HOST" "$@"; }
put() { sshpass -p "$PI_PASS" scp -q -o StrictHostKeyChecking=no -o LogLevel=ERROR "$@"; }

cd "$REPO"
css=$(ls ui/mirror/assets/index-*.css | head -1)
js=$(ls ui/mirror/assets/index-*.js | head -1)
[[ -f "$css" && -f "$js" ]] || { echo "no built bundle in ui/mirror/assets — run scripts/build-mirror-ui.sh" >&2; exit 1; }

for dest in "$CURRENT" "$CHECKOUT"; do
  # Vite content-hashes the filenames, so a stale bundle does not overwrite —
  # it accumulates. Clear them or the directory grows one pair per iteration.
  pi "rm -f $dest/ui/mirror/assets/index-*.css $dest/ui/mirror/assets/index-*.js"
  put ui/mirror/index.html "$PI_HOST:$dest/ui/mirror/index.html"
  put "$css" "$js" "$PI_HOST:$dest/ui/mirror/assets/"
  put src/mirror/mirror-contract.json "$PI_HOST:$dest/src/mirror/mirror-contract.json"
done

# Verify by content, not by exit code. scp reports success for a truncated
# write often enough that "it copied" has been wrong here before.
local_sum=$(md5 -q "$js")
remote_sum=$(pi "md5sum $CURRENT/ui/mirror/assets/$(basename "$js") | cut -d' ' -f1")
[[ "$local_sum" == "$remote_sum" ]] || { echo "bundle mismatch after copy: $local_sum != $remote_sum" >&2; exit 1; }

# The kiosk holds the old bundle until its page reloads, and the daemon holds
# the old contract until it restarts. Both, or the screenshot lies.
pi "systemctl --user restart constellation.service"
sleep 4
pi "systemctl --user restart constellation-kiosk.service"
sleep 10
pi "curl -s --max-time 5 http://127.0.0.1:8789/health"
echo
echo "pushed $(basename "$js") + $(basename "$css")"
