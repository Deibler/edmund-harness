# Native pieces of Edmund's FaceTime calls.
#
#   control  FaceTimeControl.dylib, injected into FaceTime.app (call control)
#
# Every target always recompiles. imcore-bridge's Makefile once re-signed a
# stale dylib without rebuilding it, and three "the fix didn't work"
# conclusions were about code that never reached the binary. These sources are
# small; a full build costs less than one wrong conclusion.
#
# Same load-bearing flags as the bridge: -arch arm64e (FaceTime runs arm64e
# and silently refuses plain arm64) and an ad-hoc signature (an unsigned dylib
# will not load into a hardened host even with library validation off).

BUILD_DIR := build
CONTROL   := $(BUILD_DIR)/FaceTimeControl.dylib
AUDIO_APP := $(BUILD_DIR)/EdmundCallAudio.app
MOUTH     := $(BUILD_DIR)/EdmundMouth

.PHONY: all control audio mouth driver clean
all: control audio mouth

control:
	@mkdir -p $(BUILD_DIR)
	clang -dynamiclib -fobjc-arc -fmodules -Wall -Wextra -Wno-unused-parameter -O2 \
		-arch arm64e -framework Foundation \
		-o $(CONTROL) control/FaceTimeControl.m
	codesign -f -s - --options runtime $(CONTROL)
	@echo "built $(CONTROL)"

# An app bundle, not a bare binary: macOS attributes the audio-capture
# permission to the bundle, so the prompt names EdmundCallAudio and the grant
# survives whoever launches it. Ad-hoc signing means a rebuild changes the
# code identity, and macOS asks for the permission again after one.
audio:
	@mkdir -p $(AUDIO_APP)/Contents/MacOS
	swiftc -O -swift-version 5 -target arm64-apple-macos26.0 \
		-o $(AUDIO_APP)/Contents/MacOS/EdmundCallAudio audio/*.swift
	cp audio/Info.plist $(AUDIO_APP)/Contents/Info.plist
	codesign -f -s - $(AUDIO_APP)
	@echo "built $(AUDIO_APP)"

# Edmund's voice. A plain binary: playing audio needs no permission, so it is
# kept out of the app above and can be rebuilt without asking for a new grant.
mouth:
	@mkdir -p $(BUILD_DIR)
	swiftc -O -swift-version 5 -target arm64-apple-macos26.0 \
		-o $(MOUTH) audio/HAL.swift audio/Wire.swift mouth/*.swift
	codesign -f -s - $(MOUTH)
	@echo "built $(MOUTH)"

# The split virtual mic (see driver/build.sh). Not part of `all`: it downloads
# BlackHole source, and installing it needs an administrator:
#   sudo ditto build/EdmundAudio.driver /Library/Audio/Plug-Ins/HAL/EdmundAudio.driver
#   sudo killall coreaudiod
driver:
	sh driver/build.sh $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)
