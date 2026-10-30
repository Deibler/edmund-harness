"""Has the caller finished their turn? Smart Turn v3 (pipecat-ai/smart-turn,
BSD-2), run locally on the last 8 s of their speech.

A fixed silence timer cannot tell "and then..." from "that's all": it either
cuts people off mid-thought or leaves dead air after every finished sentence.
Smart Turn judges from the audio itself, intonation included, in ~12 ms on a
CPU, so the caller's turn can end as soon as they have actually finished.

The model's own inference.py needs `transformers` only for Whisper's log-mel
features. They are reimplemented here with numpy (same STFT, Slaney mel bank,
log10 clamp and scaling, same zero-mean unit-variance normalisation of the
unpadded audio), so the shared Kokoro venv gains no dependency. They were
checked against transformers' WhisperFeatureExtractor(chunk_length=8) before
use; see the PR that added this file.

Protocol: newline-delimited JSON on stdin/stdout.
  -> {"id": "...", "pcm": "<base64 int16 mono 16 kHz>"}
  <- {"id": "...", "ok": true, "probability": 0.93, "ms": 11.4}
The first line out is {"id": "boot", "ok": true|false, ...}.

    python turn-detector.py <model.onnx>
"""

import base64
import json
import sys
import time

import numpy as np

RATE = 16_000
SECONDS = 8
N_SAMPLES = RATE * SECONDS
N_FFT = 400
HOP = 160
N_MELS = 80


def _hz_to_mel(freq):
    """Slaney mel scale: linear below 1 kHz, logarithmic above."""
    freq = np.asarray(freq, dtype=np.float64)
    mel = freq / (200.0 / 3)
    log_region = freq >= 1000.0
    mel = np.where(log_region, 15.0 + np.log(np.maximum(freq, 1e-10) / 1000.0) / (np.log(6.4) / 27.0), mel)
    return mel


def _mel_to_hz(mel):
    mel = np.asarray(mel, dtype=np.float64)
    freq = (200.0 / 3) * mel
    log_region = mel >= 15.0
    return np.where(log_region, 1000.0 * np.exp((np.log(6.4) / 27.0) * (mel - 15.0)), freq)


def _mel_filters():
    """(n_fft/2 + 1, n_mels) triangular filters with Slaney area normalisation."""
    fft_freqs = np.linspace(0, RATE // 2, 1 + N_FFT // 2)
    mel_freqs = np.linspace(_hz_to_mel(0.0), _hz_to_mel(RATE / 2), N_MELS + 2)
    filter_freqs = _mel_to_hz(mel_freqs)
    diff = np.diff(filter_freqs)
    slopes = filter_freqs[None, :] - fft_freqs[:, None]
    down = -slopes[:, :-2] / diff[:-1]
    up = slopes[:, 2:] / diff[1:]
    bank = np.maximum(0.0, np.minimum(down, up))
    bank *= (2.0 / (filter_freqs[2 : N_MELS + 2] - filter_freqs[:N_MELS]))[None, :]
    return bank


_FILTERS = _mel_filters()
_WINDOW = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)  # periodic Hann


def features(audio):
    """Whisper log-mel features for the last 8 s of `audio` (float, 16 kHz), shape (1, 80, 800)."""
    audio = np.asarray(audio, dtype=np.float64)[-N_SAMPLES:]
    length = len(audio)
    if length > 0:
        audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    padded = np.zeros(N_SAMPLES, dtype=np.float64)
    padded[:length] = audio
    centred = np.pad(padded, N_FFT // 2, mode="reflect")
    frames = 1 + (len(centred) - N_FFT) // HOP
    index = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    power = np.abs(np.fft.rfft(centred[index] * _WINDOW, n=N_FFT, axis=1)) ** 2
    mel = _FILTERS.T @ power.T
    log_spec = np.log10(np.maximum(mel, 1e-10))[:, :-1]
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    log_spec = (log_spec + 4.0) / 4.0
    return log_spec[None, :, :].astype(np.float32)


def _session(path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])


def _emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        _emit({"id": "boot", "ok": False, "error": "usage: turn-detector.py <model.onnx>"})
        return 64
    try:
        session = _session(sys.argv[1])
        session.run(None, {"input_features": features(np.zeros(RATE, dtype=np.float32))})
    except Exception as err:  # noqa: BLE001 - reported to the parent, which falls back
        _emit({"id": "boot", "ok": False, "error": str(err)})
        return 1
    _emit({"id": "boot", "ok": True})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            started = time.perf_counter()
            pcm = np.frombuffer(base64.b64decode(request["pcm"]), dtype=np.int16)
            probability = float(
                session.run(None, {"input_features": features(pcm.astype(np.float32) / 32768.0)})[0].reshape(-1)[0]
            )
            _emit({
                "id": request.get("id"),
                "ok": True,
                "probability": probability,
                "ms": round((time.perf_counter() - started) * 1000, 1),
            })
        except Exception as err:  # noqa: BLE001
            _emit({"id": (request if isinstance(request, dict) else {}).get("id"), "ok": False, "error": str(err)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
