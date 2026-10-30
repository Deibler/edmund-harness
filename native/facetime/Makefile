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

.PHONY: all control audio mouth driver turn-model clean
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

# Smart Turn v3.2 (pipecat-ai/smart-turn, BSD-2): decides whether a caller's
# pause ends their turn. Downloaded at a pinned hash; not part of `all`.
TURN_MODEL := $(BUILD_DIR)/smart-turn-v3.2-cpu.onnx
TURN_MODEL_SHA256 := 2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f
turn-model:
	@mkdir -p $(BUILD_DIR)
	curl -fsSL --connect-timeout 30 --max-time 120 -o $(TURN_MODEL).tmp \
		https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx
	echo "$(TURN_MODEL_SHA256)  $(TURN_MODEL).tmp" | shasum -a 256 -c -
	mv $(TURN_MODEL).tmp $(TURN_MODEL)
	@echo "fetched $(TURN_MODEL)"

# The split virtual mic (see driver/build.sh). Not part of `all`: it downloads
# BlackHole source, and installing it needs an administrator:
#   sudo ditto build/EdmundAudio.driver /Library/Audio/Plug-Ins/HAL/EdmundAudio.driver
#   sudo killall coreaudiod
driver:
	sh driver/build.sh $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)
