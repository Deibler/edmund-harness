#!/bin/sh
# Builds EdmundAudio.driver: a record-only "Edmund Mic" that FaceTime listens
# to, and a separate play-only "Edmund Feed" that Edmund's voice plays into.
# What plays into the Feed comes out of the Mic.
#
# Stock BlackHole 2ch is one device that both plays and records. On the live
# calls of 2026-10-29 FaceTime's measured mic level fell from -21.7 to -111 dB
# within ten seconds while it kept sending, and FaceTime switching that one
# device to 24 kHz broke Edmund's open stream on it. OpenClaw's FaceTime
# companion never uses stock BlackHole; it builds this same split pair
# (openclaw/openclaw-facetime, scripts/build-driver.sh). Ours differs in three
# deliberate ways:
#
#   - only 48 kHz is offered, so nothing on a call can change the rate under
#     a stream that is already playing;
#   - the Feed answers "never the default device", so no app's sound can be
#     routed into the call by default;
#   - neither device can be the system alert device.
#
# BlackHole is GPL-3.0. Its source is downloaded at a pinned checksum and
# built here; it is never committed.
#
# Command Line Tools are enough: the driver is one C file.
#
#   driver/build.sh <output-dir>      -> <output-dir>/EdmundAudio.driver
set -eu

version="0.7.1"
archive_sha256="e9de179da54ed55ff27876990f3a2dcfefa66e6bd6cfcba448a8564eabdf3e89"
# Our own CFPlugIn factory, so this driver and stock BlackHole can coexist.
factory_uuid="D9BC6C04-AD01-4956-ADC5-ECE71139F078"
blackhole_factory_uuid="e395c745-4eea-4d94-bb92-46224221047c"
plugin_type_uuid="443ABAB8-E7B3-491A-B985-BEB9187030DB"
name="EdmundAudio"
bundle_id="com.edmund.EdmundAudio"

out_dir=${1:?usage: build.sh <output-dir>}
mkdir -p "$out_dir"
out_dir=$(cd "$out_dir" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/edmund-driver.XXXXXX")
trap 'rm -rf "$work"' EXIT

curl -fsSL --connect-timeout 30 --max-time 120 \
  "https://github.com/ExistentialAudio/BlackHole/archive/refs/tags/v$version.tar.gz" \
  -o "$work/src.tar.gz"
printf '%s  %s\n' "$archive_sha256" "$work/src.tar.gz" | shasum -a 256 -c - >/dev/null
tar -xzf "$work/src.tar.gz" -C "$work"
src="$work/BlackHole-$version/BlackHole"

# The Feed must never be offered as a default device. BlackHole answers this
# property once for both devices, so answer it per device.
before=$(grep -c '\*((UInt32\*)outData) = kCanBeDefaultDevice;' "$src/BlackHole.c")
[ "$before" -eq 1 ] || { echo "build.sh: expected one kCanBeDefaultDevice answer, found $before" >&2; exit 1; }
sed -i '' 's/\*((UInt32\*)outData) = kCanBeDefaultDevice;/*((UInt32*)outData) = (inObjectID == kObjectID_Device2) ? 0 : kCanBeDefaultDevice;/' "$src/BlackHole.c"
grep -q 'inObjectID == kObjectID_Device2) ? 0 : kCanBeDefaultDevice' "$src/BlackHole.c" ||
  { echo "build.sh: the Feed default-device patch did not apply" >&2; exit 1; }

bundle="$work/$name.driver"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
clang -bundle -Os -Wall -Wno-unused-function \
  -arch arm64 -arch x86_64 -mmacosx-version-min=12.3 \
  -DkDriver_Name="\"$name\"" \
  -DkPlugIn_BundleID="\"$bundle_id\"" \
  -DkHas_Driver_Name_Format=false \
  -DkDevice_Name='"Edmund Mic"' \
  -DkDevice2_Name='"Edmund Feed"' \
  -DkManufacturer_Name='"Edmund"' \
  -DkNumber_Of_Channels=2 \
  -DkDevice_IsHidden=false -DkDevice2_IsHidden=false \
  -DkDevice_HasInput=true -DkDevice_HasOutput=false \
  -DkDevice2_HasInput=false -DkDevice2_HasOutput=true \
  -DkCanBeDefaultSystemDevice=false \
  -DkSampleRates=48000 \
  -framework CoreAudio -framework CoreFoundation -framework Accelerate \
  -o "$bundle/Contents/MacOS/$name" "$src/BlackHole.c"
cp "$src/BlackHole.icns" "$bundle/Contents/Resources/BlackHole.icns"

plist="$bundle/Contents/Info.plist"
sed -e "s/\${EXECUTABLE_NAME}/$name/" \
    -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/$bundle_id/" \
    -e "s/\${PRODUCT_NAME}/$name/" \
    -e "s/\$(MARKETING_VERSION)/$version/" \
    "$src/BlackHole.plist" > "$plist"
/usr/libexec/PlistBuddy -c "Delete :CFPlugInFactories:$blackhole_factory_uuid" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFPlugInFactories:$factory_uuid string BlackHole_Create" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFPlugInTypes:$plugin_type_uuid:0 $factory_uuid" "$plist"
/usr/libexec/PlistBuddy -c "Add :EdmundDriverRecipe string split-mic-feed-v1" "$plist"
/usr/libexec/PlistBuddy -c "Add :EdmundBlackHoleVersion string $version" "$plist"
plutil -lint "$plist" >/dev/null
if grep -q '\$[({]' "$plist"; then
  echo "build.sh: unexpanded build variable left in Info.plist" >&2
  exit 1
fi

codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"
rm -rf "$out_dir/$name.driver"
ditto "$bundle" "$out_dir/$name.driver"
echo "built $out_dir/$name.driver"
