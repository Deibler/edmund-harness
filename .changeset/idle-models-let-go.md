---
"edmund-harness": patch
---

Give model memory back when it is not being used. The recall embedder releases its model after a minute idle instead of five (it reloads in about 0.2 s). The mirror's speech models (Kokoro and Whisper, about 880 MB) no longer load at boot: a wake starts them while the person is talking, and they unload after 15 quiet minutes.
