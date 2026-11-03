---
"edmund-harness": patch
---

Calls are heard in the daemon, there is a voice lab for talking to Edmund from a web page, and a rebuilt audio helper keeps its macOS permission.

- **Hearing no longer depends on a recognition session that lives for the whole call.** The Ear cuts each turn from the audio's own energy and sends every stretch of speech whole to a resident Parakeet transcriber on MLX. Picked over Whisper on synthetic call clips (M4, 2026-10-30): 1.5% word error rate at 146 ms a clip against base.en's 263 ms, and it wrote nothing on breath, hum or a cough where Whisper wrote "You". A transcriber crash now costs the requests in flight, not the rest of the call, and "heard nothing" is kept apart from "could not tell".
- **The voice lab** (`[voice_lab]`, off by default) is a call with Edmund from a page on the local network, under the same manager, conversation, model, voice and turn-taking as FaceTime. Whoever opens it talks to him as the operator, so it needs the key in `data/voice-lab/key`, a private address and same-origin requests. `bun scripts/voice-lab-link.ts` prints the link. Edmund's call voice and speed are tuned there and read at every sentence, on FaceTime too.
- **The audio helper is signed with a stable self-signed identity** (`native/facetime/signing-identity.sh`, once per Mac), and the daemon checks the capture permission before every call. An ad-hoc signature tied the grant to one exact build, so every rebuild lost it on 2026-10-29 and 2026-10-30, and a call without it looks heard and is deaf.
