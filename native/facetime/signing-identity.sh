#!/bin/bash
# Creates the identity EdmundCallAudio is signed with. Run once per Mac.
#
# macOS ties the helper's audio-capture permission to its code identity. An
# ad-hoc signature is the build's own hash, so every rebuild lost the grant
# and macOS refused the new build without asking (2026-10-29, 2026-10-30). A
# certificate stays the same across builds: the grant names it, and a rebuild
# keeps the permission.
#
# Self-signed, and used for nothing but this helper. It lives in its own
# keychain under data/signing (gitignored), opened with a password kept beside
# it, so a build never needs the login keychain or anyone's password.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/data/signing"
keychain="$dir/edmund-signing.keychain-db"
name="Edmund Call Audio Signing"

if [ -e "$keychain" ]; then
  echo "already set up: $keychain"
  exit 0
fi

umask 077
mkdir -p "$dir"
password=$(openssl rand -hex 24)
printf %s "$password" >"$dir/keychain-password"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -subj "/CN=$name" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
transfer=$(openssl rand -hex 16)
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$work/identity.p12" -passout "pass:$transfer"

# create-keychain may add the keychain to the search list; only signing needs
# it there (sign-audio.sh), so the list is put back as it was.
listed=()
while IFS= read -r line; do
  line=${line#*\"}
  listed+=("${line%\"}")
done < <(security list-keychains -d user)
security create-keychain -p "$password" "$keychain"
security list-keychains -d user -s "${listed[@]}"

# No idle timeout and no lock on sleep; sign-audio.sh unlocks it after a restart.
security set-keychain-settings "$keychain"
security import "$work/identity.p12" -k "$keychain" -P "$transfer" -T /usr/bin/codesign >/dev/null
# Lets codesign use the key without a prompt nobody would be there to answer.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null

echo "created \"$name\" in $keychain"
