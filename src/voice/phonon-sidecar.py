#!/usr/bin/env python3
"""Phonon speech for calls, as a warm sidecar speaking speech-sidecar.py's protocol.

    TTS  → {"id": "1", "text": "Good morning.", "voice": "Micah", "speed": 1.0}
         ← {"id": "1", "ok": true, "pcm16": "<base64>", "rate": 24000, "ms": 118}

    list → {"id": "3", "voices": true}
         ← {"id": "3", "ok": true, "voices": ["Zoey", ...]}   the catalog's English voices

         ← {"id": "N", "ok": false, "error": "..."}

Phonon 31m (gradium/phonon-31m-en, Apache 2.0) through `ptts`: a 31M-parameter
model with no PyTorch behind it. Measured on this M4 on 2026-11-12, on 200
sentences Edmund had said on calls, in each of three voices: a whole sentence
in a median 124 ms (p90 200, worst 340) against Kokoro's 686 ms; 38 to 48 of
2,229 words transcribed back wrong against Kokoro's 31 to 49; no sentence
repeated or run on; about 450 MB resident.

On the CPU, on purpose: it took 109 ms a sentence there and 267 ms on Metal,
and the GPU is what a call's hearing runs on.

The same request and reply as Kokoro's sidecar, so the daemon's SpeechSidecar
drives either. stdout carries only protocol lines; diagnostics go to stderr
with a "[phonon]" prefix, which the parent logs.
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import time

_STDOUT = sys.stdout
sys.stdout = sys.stderr

# A sample is speech when its 10 ms level is above this share of the clip's
# loudest. Phonon's pads sit 46 dB (before) and 65 dB (after) below it.
LOUD = 0.03
# A clip whose loudest 10 ms is below this is not speech. Over 600 sentences the
# quietest clip peaked at 0.062 and the pads sat at 0.0023.
QUIET = 0.01
# Phonon leaves a median 0.14 s of near-silence before a sentence and 0.63 s
# after it (200 sentences). Left in, every sentence would start late and be
# followed by most of a second of nothing. What is kept: enough before for a
# soft first consonant, and after for the last one to die away.
LEAD_S = 0.05
TAIL_S = 0.12
# `duration_delta` outside this was not tried except -2, which ran on for 13 s.
MAX_DELTA = 0.5
# Speech this long for the text is the model running on. The slowest of 600
# sentences took 0.092 s a character, so this is three times the worst seen.
RUNAWAY_BASE_S = 3.0
RUNAWAY_PER_CHAR_S = 0.3


def _emit(payload: dict) -> None:
    _STDOUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    _STDOUT.flush()


def _log(message: str) -> None:
    print(f"[phonon] {message}", file=sys.stderr, flush=True)


def speed_to_delta(speed: float) -> float | None:
    """Phonon's `duration_delta` for a speed factor, or None for its own pace.

    The delta acts as a change in log duration near its own pace: -0.3 was
    1.32x, -0.15 was 1.19x, +0.15 was 0.88x (42 clips each), where -ln(speed)
    says 1.35x, 1.16x and 0.86x. Further out it does less than that, and it is
    held to the range that was tried.
    """
    if not (speed > 0) or abs(speed - 1.0) < 0.005:
        return None
    return max(-MAX_DELTA, min(MAX_DELTA, -math.log(speed)))


def speech_bounds(samples, rate: int):
    """First and last sample that is speech, or None when nothing is."""
    import numpy as np

    if len(samples) == 0:
        return None
    win = max(1, int(rate * 0.010))
    power = np.convolve(np.asarray(samples, dtype=np.float64) ** 2, np.ones(win) / win, mode="same")
    level = np.sqrt(power)
    peak = float(level.max())
    if peak < QUIET:
        return None
    loud = np.nonzero(level > LOUD * peak)[0]
    return int(loud[0]), int(loud[-1])


def trim(samples, rate: int):
    """`samples` without Phonon's pads, faded at both cuts so neither clicks."""
    import numpy as np

    bounds = speech_bounds(samples, rate)
    if bounds is None:
        return samples[:0]
    first, last = bounds
    start = max(0, first - int(LEAD_S * rate))
    end = min(len(samples), last + int(TAIL_S * rate))
    out = np.array(samples[start:end], dtype=np.float32)
    fade_in = min(len(out), int(0.010 * rate)) if start > 0 else 0
    if fade_in:
        out[:fade_in] *= np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
    fade_out = min(len(out), int(0.030 * rate)) if end < len(samples) else 0
    if fade_out:
        out[-fade_out:] *= np.linspace(1.0, 0.0, fade_out, dtype=np.float32)
    return out


def ran_on(seconds: float, text: str) -> bool:
    return seconds > RUNAWAY_BASE_S + RUNAWAY_PER_CHAR_S * len(text)


def main() -> int:
    try:
        import numpy as np
        import ptts
    except Exception as err:  # noqa: BLE001 - any import failure is equally fatal
        _emit({"id": "boot", "ok": False, "error": f"import failed: {err}"})
        return 2

    model = os.environ.get("PHONON_MODEL") or ptts.DEFAULT_MODEL
    device = os.environ.get("PHONON_DEVICE") or "cpu"
    started = time.perf_counter()
    try:
        tts = ptts.TTS(model, lang="en", device=device)
    except Exception as err:  # noqa: BLE001
        _emit({"id": "boot", "ok": False, "error": f"model load failed: {err}"})
        return 2
    rate = int(tts.sample_rate)
    _log(f"loaded in {time.perf_counter() - started:.2f}s on {tts.device}")

    delta: float | None = None

    def set_pace(speed: float) -> None:
        nonlocal delta
        wanted = speed_to_delta(speed)
        if wanted == delta:
            return
        tts.set_conditions({} if wanted is None else {"duration_delta": wanted})
        delta = wanted

    def speak(text: str, voice: str, speed: float):
        """Trimmed float32 speech. Raises when the voice is unknown or the model ran on twice."""
        set_pace(speed)
        for attempt in (1, 2):
            # Phonon reads a text the same way every time it is asked (the
            # samples are identical), so a second chance needs another seed.
            seed = None if attempt == 1 else attempt
            samples = trim(tts.synth(text, voice=voice, seed=seed), rate)
            seconds = len(samples) / rate
            if len(samples) and not ran_on(seconds, text):
                return samples
            _log(f"attempt {attempt}: {seconds:.1f}s of speech for {len(text)} characters; discarded")
        raise RuntimeError("no usable speech in two attempts")

    # The first synthesis in a voice fetches it (once, then it is cached) and
    # warms the model. Not fatal: with no network and no cache the model still
    # serves every voice it does have, and the parent has another voice to
    # fall back on for the rest.
    warm_voice = os.environ.get("PHONON_VOICE") or ""
    if warm_voice:
        try:
            speak("Ready.", warm_voice, 1.0)
        except Exception as err:  # noqa: BLE001
            _log(f"could not warm {warm_voice!r}: {err}")

    # The names a setting may use: the catalog's English voices. Read from the
    # cache when there is no network; without either, only what is loaded.
    try:
        catalog = [v["name"] for v in ptts.catalog_voices() if v.get("language") == "en"]
    except Exception as err:  # noqa: BLE001
        _log(f"voice catalog unavailable ({err}); listing loaded voices only")
        catalog = [name for name in tts.voices if name != "default"]

    _emit({"id": "boot", "ok": True, "ready": True, "detail": f"device={tts.device} voices={len(catalog)}"})

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
        if request.get("voices"):
            _emit({"id": request_id, "ok": True, "voices": catalog})
            continue

        text = request.get("text")
        if not isinstance(text, str) or not text.strip():
            _emit({"id": request_id, "ok": False, "error": "text is required"})
            continue
        voice = request.get("voice") or warm_voice
        if not isinstance(voice, str) or not voice:
            _emit({"id": request_id, "ok": False, "error": "voice is required"})
            continue
        try:
            speed = min(2.0, max(0.5, float(request.get("speed", 1.0))))
        except (TypeError, ValueError):
            speed = 1.0

        began = time.perf_counter()
        try:
            samples = speak(text, voice, speed)
        except Exception as err:  # noqa: BLE001 - a bad voice must not kill the sidecar
            _emit({"id": request_id, "ok": False, "error": f"synthesis failed: {err}"})
            continue

        clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
        pcm16 = (clipped * 32767.0).astype("<i2").tobytes()
        _emit(
            {
                "id": request_id,
                "ok": True,
                "pcm16": base64.b64encode(pcm16).decode("ascii"),
                "rate": rate,
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
        sys.exit(0)
