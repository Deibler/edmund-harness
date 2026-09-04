---
name: voice-memo
description: Reply with a spoken audio clip, or transcribe incoming voice notes.
---

# voice-memo

## Reply with audio

1. `generate_audio(text, voice?, async: true)` — TTS speech (always pass `async: true`); the file AUTO-DELIVERS to the user, no follow-up `send_attachment`.
2. Voices: alloy / echo / fable / onyx / nova / shimmer (model-dependent). `list_audio_models()` if the user wants a specific style.

Use when the user asks for a voice memo, wants to hear something, or the moment calls for tone. Keep the spoken text shorter than you would a typed reply — people listen impatiently.

## Handle incoming voice notes

When the user sends an audio attachment, check the envelope's Attachments line first — voice notes usually arrive pre-transcribed (`[voice transcript: "…"]`). If not, call `transcribe_audio(file_path=<path from the attachment list>)` before responding. Treat the transcript as the user's message. (Videos get the same treatment automatically; for everything else video, `read_skill("video")`.)
