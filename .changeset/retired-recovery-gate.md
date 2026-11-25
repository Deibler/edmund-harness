---
"edmund-harness": patch
---

Answer the operator when a message begins with "Claude", and drop settings that nothing read.

- A message from the operator that began with "Claude " (capital C, then a space) was dropped at admission, with no log line unless `DEBUG` was set. The gate handed those messages to a separate recovery daemon, and stayed after that daemon was retired. It is gone, along with `edmund recovery`, which tailed that daemon's logs.
- `[tools] image_provider`, `image_model` and `tts_voice`, `[behavior] auto_typing_seconds`, and `[grok] model` and `effort` are removed from the schema, the example config, the docs and the dashboard's settings page. No code read any of them: images, audio and video go through `[openrouter]`. A config file that still sets them loads as before, because unknown keys are ignored.
