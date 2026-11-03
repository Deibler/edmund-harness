"""What did the caller say? Parakeet TDT 0.6B v2 (NVIDIA, CC-BY-4.0) on Metal
through parakeet-mlx, one finished stretch of speech per request.

A call's hearing used to be a streaming recognition session that lived for
the whole call: when Apple's recogniser died inside it, nothing distinguished
a deaf call from a silent caller. Here every request is self-contained. The
daemon cuts the audio and sends each stretch whole, so there is no session to
die, finalize or restart, and a failure is one answered request, never
silence.

Measured on this Mac (M4, 2026-10-30), Kokoro speech in six voices, clean
and at 15 dB SNR: 1.5% / 2.2% word error, 146 ms median per utterance
(0.05x real time), nothing at all on noise-only clips (white, pink, hum,
breath, clicks, a cough), where Whisper base.en and small.en wrote "You".
~0.9 GB resident.

One-word replies are the weak spot, for every engine tried: on 80 synthetic
"Yes." / "No." / "Okay." clips, 11 came back wrong or empty. Padding moves it
around (a quarter second: 4 empty, half: 4, a full second: 1, a second and a
half: 7), so every clip gets a second of silence either side.

Protocol: newline-delimited JSON on stdin/stdout.
  -> {"id": "...", "pcm": "<base64 int16 mono 16 kHz>"}
  <- {"id": "...", "ok": true, "text": "what's the weather", "ms": 146}
The first line out is {"id": "boot", "ok": true|false, ...}.

    python transcriber.py [hf-model-id]
"""

import base64
import json
import sys
import time

# Import-time chatter from mlx or huggingface would corrupt the protocol if
# it reached stdout.
_STDOUT = sys.stdout
sys.stdout = sys.stderr

import numpy as np  # noqa: E402

RATE = 16_000
MODEL = "mlx-community/parakeet-tdt-0.6b-v2"
PAD = np.zeros(RATE, dtype=np.float32)


def _emit(payload):
    _STDOUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    _STDOUT.flush()


def main():
    try:
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel

        started = time.perf_counter()
        model = from_pretrained(sys.argv[1] if len(sys.argv) > 1 else MODEL)
        config = model.preprocessor_config

        def transcribe(audio):
            padded = np.concatenate([PAD, audio, PAD])
            return model.generate(get_logmel(mx.array(padded), config))[0].text.strip()

        # The first pass compiles the Metal kernels; pay it before anyone talks.
        transcribe(np.zeros(RATE, dtype=np.float32))
    except Exception as err:  # noqa: BLE001 - reported to the parent
        _emit({"id": "boot", "ok": False, "error": str(err)})
        return 1
    _emit({"id": "boot", "ok": True, "ms": round((time.perf_counter() - started) * 1000)})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            began = time.perf_counter()
            pcm = np.frombuffer(base64.b64decode(request["pcm"]), dtype=np.int16)
            text = transcribe(pcm.astype(np.float32) / 32768.0)
            _emit({
                "id": request.get("id"),
                "ok": True,
                "text": text,
                "ms": round((time.perf_counter() - began) * 1000),
            })
        except Exception as err:  # noqa: BLE001
            _emit({"id": (request if isinstance(request, dict) else {}).get("id"), "ok": False, "error": str(err)})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
