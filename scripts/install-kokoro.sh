#!/usr/bin/env bash
# Provision local Kokoro-82M speech synthesis for the mirror.
#
# Everything lands under ~/.local/share/edmund-harness so nothing enters the
# repo and the daemon needs no path configuration. Re-running is safe: each
# step is skipped when its output already exists.
#
# Why these choices, measured on this Mac (M4) rather than assumed:
#   * fp32, not int8 — int8 ran 2x SLOWER (ARM dequantization overhead).
#   * CPU provider, not CoreML — CoreML split the graph into 109 partitions
#     for no throughput gain and a 7x worse cold load.
set -Eeuo pipefail

ROOT=${KOKORO_ROOT:-$HOME/.local/share/edmund-harness}
VENV=$ROOT/kokoro-venv
MODELS=$ROOT/kokoro-models
RELEASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0

say() { printf '[kokoro] %s\n' "$*"; }
die() { printf '[kokoro] %s\n' "$*" >&2; exit 1; }

# kokoro-onnx pins <3.13 in some builds; 3.13 is what this Mac has and works.
python_bin=${KOKORO_PYTHON:-}
if [[ -z "$python_bin" ]]; then
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      python_bin=$(command -v "$candidate")
      break
    fi
  done
fi
[[ -n "$python_bin" ]] || die 'no python3 found; install one (brew install python@3.13)'
say "using $python_bin ($("$python_bin" --version 2>&1))"

mkdir -p "$ROOT" "$MODELS"

if [[ ! -x "$VENV/bin/python3" ]]; then
  say 'creating venv'
  "$python_bin" -m venv "$VENV"
fi

if ! "$VENV/bin/python3" -c 'import kokoro_onnx' >/dev/null 2>&1; then
  say 'installing kokoro-onnx (bundles its own espeak-ng loader)'
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet kokoro-onnx soundfile
fi

# Recognition shares the sidecar. Its weights download on first use rather than
# here, so this stays a dependency install and the model choice stays config.
if ! "$VENV/bin/python3" -c 'import faster_whisper' >/dev/null 2>&1; then
  say 'installing faster-whisper for local speech recognition'
  "$VENV/bin/pip" install --quiet faster-whisper
fi

# ~325 MB. The 92 MB int8 build is deliberately not used; see the header.
fetch() {
  local name=$1 min_bytes=$2 path=$MODELS/$1
  if [[ -f "$path" ]]; then
    local size
    size=$(wc -c <"$path")
    if (( size >= min_bytes )); then
      say "$name already present"
      return 0
    fi
    say "$name is truncated (${size}B); refetching"
    rm -f "$path"
  fi
  say "downloading $name"
  # Stage under a temp name so an interrupted download is never mistaken for a
  # complete one on the next run.
  curl -fL --retry 3 --retry-delay 2 -o "$path.part" "$RELEASE/$name"
  local size
  size=$(wc -c <"$path.part")
  (( size >= min_bytes )) || { rm -f "$path.part"; die "$name downloaded short (${size}B)"; }
  mv -f "$path.part" "$path"
}

fetch kokoro-v1.0.onnx 300000000
fetch voices-v1.0.bin 25000000

say 'verifying end to end'
"$VENV/bin/python3" - "$MODELS" <<'PY'
import sys, time
from pathlib import Path
models = Path(sys.argv[1])
from kokoro_onnx import Kokoro
t0 = time.perf_counter()
k = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
load = time.perf_counter() - t0
t0 = time.perf_counter()
samples, rate = k.create("Local speech is working.", voice="af_heart", speed=1.0, lang="en-us")
synth = time.perf_counter() - t0
assert rate == 24000, f"expected 24kHz, got {rate}"
assert len(samples) > 0, "no audio produced"
print(f"[kokoro] load {load:.2f}s | synth {synth:.2f}s for {len(samples)/rate:.2f}s audio @ {rate}Hz")
PY

cat <<EOF

[kokoro] ready. Enable it in config.toml:

  [mirror]
  kokoro_enabled = true
  kokoro_voice = "af_heart"
  local_stt_model = "base.en"   # "" keeps recognition on the hosted path

Then restart the daemon. Voice options are listed at
https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
(af_heart and af_bella grade highest; am_fenrir/am_puck lead the male voices).
EOF
