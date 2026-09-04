# Wake detection

## What was wrong

The Pi's wake gate (`deploy/mirror-wake.py`, which lives only on the Pi) runs
`vosk-model-small-en-us-0.15` against a grammar built from the wake words themselves:

```python
grammar = json.dumps([*WAKE_WORDS, "[unk]"])
recognizer = KaldiRecognizer(model, RATE, grammar)
```

That is a general ASR decoder with its vocabulary starved down to five tokens. Every sound
in the room has to come out as a wake word or as `[unk]`, and `[unk]` is a weak competitor,
so ordinary speech lands on "edmund". It then fires on `PartialResult()` — the least
reliable output Vosk produces — with **no confidence threshold**, because a constrained
decoder never emits a number to threshold in the first place.

Reported symptom: talking in the kitchen, or to the Alexa in the same room, woke the mirror
and opened a model turn.

## The replacement

openWakeWord. Chosen over Porcupine because it is self-hosted with no access key, so the
mirror keeps working with no network, and because it bundles the two things the current
implementation hand-rolls badly.

| | Vosk grammar hack | openWakeWord |
|---|---|---|
| Output | a partial text hypothesis | calibrated 0–1 confidence per 80 ms frame |
| Tuning | none available | threshold against a false-accepts/hour target |
| Endpointing | hand-rolled RMS level gate | bundled Silero VAD |
| Speaker filtering | none | optional voice-specific verifier |
| CPU (measured, Pi 4, one core) | **25.7%** | **32.7%** |
| Memory (measured) | ~146 MB | ~180 MB |

### Correction: it is not cheaper

An earlier version of this file claimed openWakeWord was *cheaper* than what it
replaces, on the strength of an upstream line about a Pi 3 running 15–20 models on one
core. Measured on our actual Pi 4 (aarch64, Python 3.13, `OMP_NUM_THREADS=1`), that is
wrong:

```
openWakeWord   26.2 ms per 80 ms frame    32.7% of one core
Vosk grammar   64.2 ms per 250 ms chunk   25.7% of one core
```

So it costs about **seven points more of one core**, a ~27% relative increase. It is a
trade, and worth making for a confidence value, a real VAD, and a tunable threshold —
but it should be described as one.

The upstream claim is about the *marginal* cost of extra models, and that part holds:
the melspectrogram and embedding stages are shared, so each additional wake model costs
only **0.4–1.1 ms** a frame. That is why training both `"edmund"` and `"hey edmund"` is
close to free, not why the first one is.

Both models still leave two thirds of one core idle on a 4-core Pi, and the wake unit's
`MemoryMax` is 700 MB against ~348 MB resident with Vosk and openWakeWord both loaded.

Licensing is clean — openWakeWord's code is Apache-2.0 and piper-sample-generator is MIT.
Only their *pretrained* models are CC-BY-NC-SA, and we train our own on the frozen Google
TFHub embedding, which is Apache-2.0.

## Why training runs in Colab and not here

Not preference — disk. The precomputed negative feature set is **16.5 GB** and no smaller
version is published; with background audio, synthetic clips and their augmented copies the
job needs ~22–25 GB. The Mac has 28 GB free and runs the daemon, and the only genuinely
reclaimable caches are ~4 GB (`~/.cache/huggingface` and `~/.cache/whisper` are the mirror's
own kokoro and Whisper models — deleting those breaks the voice pipeline).

Separately, openWakeWord documents automated training as Linux-only because of Piper, and
its pins (`tensorflow-cpu==2.8.1`, `onnx_tf==1.10.0`) have no arm64-macOS builds.

## Running it

Open `train-edmund-wake.ipynb` in Colab, set the runtime to **T4 GPU**, Run all. ~1.5–3 h.
It downloads ~20 GB and produces `edmund.onnx`.

Two configuration decisions are already made in it:

- **Both `"edmund"` and `"hey edmund"` are trained.** The bare name is two syllables, which
  is short for a wake word and is a genuine accuracy ceiling regardless of engine —
  openWakeWord's own models are "hey jarvis", "hey mycroft", "alexa". Training both means
  the bare name keeps working, with a better-discriminating phrase available if false
  accepts persist after threshold tuning.
- **`custom_negative_phrases` is seeded with the false wakes actually observed**, plus
  "alexa"/"echo"/"amazon" for the device sharing the room. The trainer generates
  phonetically overlapping negatives on its own; this list is for real-world ones it would
  not guess. **Adding to this list is the maintenance path** when a new false wake turns
  up — not hand-tuning thresholds, and not extending the string matcher described below.

## The infrastructure is already built and deployed

All of it except the model itself. Dropping `edmund.onnx` into
`~/mirror-models/` on the Pi and restarting the wake service is the entire
remaining step — everything below is live now, running the Vosk fallback.

Runtime code lives in **constellation**, not here (this directory is the training side):

| File | What it does |
|---|---|
| `deploy/mirror_wake_detect.py` | Both detectors behind one interface, plus `build_detector`, which prefers a trained model and falls back loudly. |
| `deploy/mirror-wake.py` | Reads frames at whatever size the chosen detector wants, posts `/wake` with the score. |
| `deploy/wake-bench.py` | Threshold tuning: `listen` measures false accepts/hour, `test` measures that it still wakes for you. |

Two corrections to what this file used to say:

- **Vosk is not dropped.** It also drives the live on-screen transcript during capture
  (`LivePartials`), which is a separate job from deciding a wake happened. Only the wake
  decision moved.
- **`mirror-wake.py` was already under version control**, at `constellation/deploy/`. It
  never lived only on the Pi.

The `PlaybackEchoGate` RMS gate is gone from the scored path — a calibrated detector just
raises its threshold while Edmund is speaking (`MIRROR_WAKE_THRESHOLD_SPEAKING`, default
0.7 against 0.5 idle). It survives only inside `VoskGrammarDetector`, where there is no
score to raise.

### When the model finishes

1. Copy `edmund.onnx` to `~/mirror-models/edmund.onnx` on the Pi. It is picked up on
   restart; no config change is needed. `MIRROR_WAKE_MODELS` overrides the path and
   accepts a comma-separated list, which is how you run `"edmund"` and `"hey edmund"`
   together.
2. Tune the threshold with real room audio — **stop the wake service first**, it holds
   the microphone:

   ```
   systemctl --user stop constellation-mirror-wake.service
   python3 deploy/wake-bench.py listen --minutes 60      # target < 0.5 false accepts/hour
   python3 deploy/wake-bench.py test --says 10           # and confirm it still wakes
   systemctl --user start constellation-mirror-wake.service
   ```

   Both directions matter. A threshold with a perfect false-accept rate that never wakes
   for you is worse than what it replaced. `listen` reports the score percentiles so you
   can pick a threshold just above the loudest thing the room produced, then check that
   `test` still clears it.
3. Set `MIRROR_WAKE_THRESHOLD` in `~/.config/constellation/environment` to what you
   measured.
4. **Delete `addressesEdmund` from `src/mirror/utterance.ts`.** It verifies a wake by
   fuzzy-matching a transcript against a curated list of spellings — a compensating
   control for a detector that emits no confidence. The agent already skips it whenever a
   score arrives; once the Vosk fallback is gone, the whole heuristic goes rather than
   being maintained.

Consider a voice-specific verifier model at that point too. It is the acoustic, principled
version of what the string matcher was faking, and it is what actually distinguishes the
Alexa's voice from a person's.
