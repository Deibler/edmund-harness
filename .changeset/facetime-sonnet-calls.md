---
"edmund-harness": patch
---

FaceTime calls start replying sooner.

- A conversation on a live call runs on `[facetime] model` (default `claude-sonnet-5-5`; empty keeps its own model), with the same transcript and memory. Opus took 3.1-7.7 s per spoken reply at `low` effort with 116k of context. In a side-by-side test (same prompt, low effort, 3 runs, including ~2 s of CLI start-up), the first word came at 3.2-6.3 s for Opus, 2.2-3.0 s for Sonnet and 2.5-2.7 s for Haiku. Kokoro's ~0.6 s per sentence was never the constraint. Switching costs no extra cache: the respawn as the call rings already rewrites the prompt cache (9% read), because the tool list leads the prompt.
- Call turns skip automatic recall, which each spoken reply waited on (~0.6 s). The model can still search.
- The call envelope asks for a few words before any tool call, which are spoken while it runs. One reply was 14 s of silence while it looked up `spawn_agent` and started it.
