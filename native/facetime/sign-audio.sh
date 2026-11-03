#!/bin/bash
# Signs EdmundCallAudio.app with the identity signing-identity.sh created, so
# a rebuild keeps macOS's audio-capture grant.
#
# A Mac that never set one up signs ad-hoc, and every rebuild there needs the
# grant made again by hand (the daemon refuses calls until it is). A Mac that
# has one never signs ad-hoc: if signing with it fails, the build fails,
# because an ad-hoc build would silently cost the grant.
#
#   sign-audio.sh <path to EdmundCallAudio.app>
set -euo pipefail

app=$1
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/data/signing"
keychain="$dir/edmund-signing.keychain-db"
name="Edmund Call Audio Signing"

if [ ! -e "$keychain" ]; then
  echo "no signing identity (native/facetime/signing-identity.sh): signing ad-hoc," \
    "so macOS's audio-capture grant will not survive this build" >&2
  exec codesign -f -s - "$app"
fi

security unlock-keychain -p "$(cat "$dir/keychain-password")" "$keychain"

# codesign looks for identities only in keychains on the search list, so this
# one is listed for the signature and the list is put back afterwards.
listed=()
while IFS= read -r line; do
  line=${line#*\"}
  listed+=("${line%\"}")
done < <(security list-keychains -d user)
trap 'security list-keychains -d user -s "${listed[@]}"' EXIT
security list-keychains -d user -s "${listed[@]}" "$keychain"

codesign -f -s "$name" --keychain "$keychain" "$app"

# Checked on the result, not taken from codesign's exit status. Read whole
# first: grep -q closing the pipe early fails codesign under pipefail.
signature=$(codesign -dvv "$app" 2>&1)
if ! grep -qx "Authority=$name" <<<"$signature"; then
  echo "$app is not signed by \"$name\"" >&2
  exit 1
fi
