#!/usr/bin/env python3
"""Local speech for the mirror — synthesis and recognition — as a warm sidecar.

Both directions live in one process on purpose: each holds a model that costs
seconds to load and hundreds of megabytes to keep resident, and a voice turn
uses them back to back. Two processes would double the memory and the
supervision for no gain.

    TTS  → {"id": "1", "text": "Good morning.", "voice": "af_heart"}
         ← {"id": "1", "ok": true, "pcm16": "<base64>", "rate": 24000, "ms": 358}

    STT  → {"id": "2", "stt": true, "wav": "<base64>"}
         ← {"id": "2", "ok": true, "text": "what's the weather", "ms": 253}

         ← {"id": "N", "ok": false, "error": "..."}

Requests are correlated by `id`; the parent may not assume responses arrive in
request order. Synthesized audio leaves as 24 kHz mono PCM16 — the same shape
OpenRouter's /audio/speech returns, so the caller wraps either in one WAV header
and the Pi cannot tell them apart.

Recognition loads lazily: a mirror that only ever speaks never pays for Whisper.

stdout carries only protocol lines. Everything diagnostic goes to stderr,
which the parent logs; onnxruntime and phonemizer both chatter there.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time

# Import-time chatter from onnxruntime/phonemizer would corrupt the protocol if
# anything reached stdout, so keep the handle honest from the very first line.
_STDOUT = sys.stdout
sys.stdout = sys.stderr


def _emit(payload: dict) -> None:
    _STDOUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    _STDOUT.flush()


def _log(message: str) -> None:
    print(f"[kokoro] {message}", file=sys.stderr, flush=True)


_whisper = None
_whisper_failed = False


def _load_whisper():
    """Load the recognizer on first use, once, and never retry a hard failure.

    Deferred so a mirror that only speaks never pays the load, and cached
    negatively so a missing dependency costs one log line rather than a stall on
    every utterance — the caller falls back to the hosted endpoint either way.
    """
    global _whisper, _whisper_failed
    if _whisper is not None or _whisper_failed:
        return _whisper
    size = os.environ.get("WHISPER_MODEL", "base.en")
    try:
        from faster_whisper import WhisperModel

        started = time.perf_counter()
        # int8 on CPU: measured ~0.25s for a typical utterance on this M4, and
        # the Neural Engine is not reachable from this runtime anyway.
        _whisper = WhisperModel(size, device="cpu", compute_type="int8")
        _log(f"whisper {size} loaded in {time.perf_counter() - started:.2f}s")
    except Exception as err:  # noqa: BLE001
        _whisper_failed = True
        _log(f"whisper unavailable ({err}); recognition will use the hosted path")
    return _whisper


def _handle_stt(request: dict, request_id: str) -> None:
    import base64 as _b64
    import tempfile

    payload = request.get("wav")
    if not isinstance(payload, str) or not payload:
        _emit({"id": request_id, "ok": False, "error": "wav is required"})
        return
    model = _load_whisper()
    if model is None:
        _emit({"id": request_id, "ok": False, "error": "whisper unavailable"})
        return

    began = time.perf_counter()
    try:
        audio = _b64.b64decode(payload, validate=True)
    except Exception:  # noqa: BLE001
        _emit({"id": request_id, "ok": False, "error": "wav is not valid base64"})
        return
    # faster-whisper reads from a path; a temp file is cheaper than decoding the
    # container by hand and keeps format support identical to the CLI.
    with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
        handle.write(audio)
        handle.flush()
        try:
            segments, _info = model.transcribe(
                handle.name,
                language="en",
                beam_size=1,
                # The wake word is a name recognizers love to mangle; bias it the
                # same way the hosted path is prompted.
                initial_prompt="Voice commands to Edmund, a smart mirror assistant.",
            )
            text = " ".join(segment.text for segment in segments).strip()
        except Exception as err:  # noqa: BLE001
            _emit({"id": request_id, "ok": False, "error": f"transcription failed: {err}"})
            return
    _emit(
        {
            "id": request_id,
            "ok": True,
            "text": text,
            "ms": int((time.perf_counter() - began) * 1000),
        }
    )


def main() -> int:
    model_path = os.environ.get("KOKORO_MODEL")
    voices_path = os.environ.get("KOKORO_VOICES")
    if not model_path or not voices_path:
        _emit({"id": "boot", "ok": False, "error": "KOKORO_MODEL/KOKORO_VOICES are unset"})
        return 2
    for label, path in (("model", model_path), ("voices", voices_path)):
        if not os.path.isfile(path):
            _emit({"id": "boot", "ok": False, "error": f"{label} not found at {path}"})
            return 2

    try:
        import numpy as np
        from kokoro_onnx import Kokoro
    except Exception as err:  # noqa: BLE001 — any import failure is equally fatal
        _emit({"id": "boot", "ok": False, "error": f"import failed: {err}"})
        return 2

    started = time.perf_counter()
    try:
        kokoro = Kokoro(model_path, voices_path)
    except Exception as err:  # noqa: BLE001
        _emit({"id": "boot", "ok": False, "error": f"model load failed: {err}"})
        return 2
    _log(f"loaded in {time.perf_counter() - started:.2f}s")

    # The first synthesis pays one-time allocator and graph-warmup costs. Do it
    # before announcing readiness so the user's first spoken reply is not the
    # slow one.
    warm_voice = os.environ.get("KOKORO_VOICE", "af_heart")
    try:
        kokoro.create("Ready.", voice=warm_voice, speed=1.0, lang="en-us")
    except Exception as err:  # noqa: BLE001
        _emit({"id": "boot", "ok": False, "error": f"warmup failed: {err}"})
        return 2

    # Whisper is the other half of the round trip and otherwise loads lazily on
    # the first utterance — where its ~1.2s lands as a pause between the user
    # finishing their sentence and Edmund reacting to it. Pull it in here, off
    # the critical path. Not fatal if it fails: hosted STT still covers us, and
    # _load_whisper() already negative-caches so we won't retry per request.
    _load_whisper()

    _emit({"id": "boot", "ok": True, "ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            _emit({"id": "unknown", "ok": False, "error": "malformed request"})
            continue

        request_id = str(request.get("id", "unknown"))
        if request.get("ping"):
            _emit({"id": request_id, "ok": True, "pong": True})
            continue

        if request.get("stt"):
            _handle_stt(request, request_id)
            continue

        text = request.get("text")
        if not isinstance(text, str) or not text.strip():
            _emit({"id": request_id, "ok": False, "error": "text is required"})
            continue

        voice = request.get("voice") or warm_voice
        speed = request.get("speed", 1.0)
        try:
            speed = min(2.0, max(0.5, float(speed)))
        except (TypeError, ValueError):
            speed = 1.0

        began = time.perf_counter()
        try:
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        except Exception as err:  # noqa: BLE001 — a bad voice must not kill the sidecar
            _emit({"id": request_id, "ok": False, "error": f"synthesis failed: {err}"})
            continue

        # float32 [-1, 1] → PCM16 LE. Clip first: the vocoder can overshoot
        # unity on sibilants, and a wrapped int16 is an audible click.
        clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
        pcm16 = (clipped * 32767.0).astype("<i2").tobytes()
        _emit(
            {
                "id": request_id,
                "ok": True,
                "pcm16": base64.b64encode(pcm16).decode("ascii"),
                "rate": int(rate),
                "ms": int((time.perf_counter() - began) * 1000),
            }
        )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except BrokenPipeError:
        # The parent went away; nothing left to serve.
        sys.exit(0)
