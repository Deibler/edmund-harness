---
"edmund-harness": minor
---

Edmund can take and place FaceTime audio calls, off by default (`[facetime]`).

- A call is a voice mode of an existing conversation: a contact's call runs in their DM session, a Group FaceTime in that group's session (`chat.group_id` = the conversation's Messages group). What was said by text carries onto the call, and the call stays in the transcript afterwards.
- `allow`/`deny` over handles, group GUIDs, `"operator"` and `"contacts"`; empty admits nobody and deny wins. Calling anyone but the session's own person needs the operator tier. A call that connects to anyone other than the person dialled is hung up and alerted.
- Hearing is Apple's on-device SpeechAnalyzer on a muted Core Audio tap of the call, so nothing reaches the Mac's speakers; a guard keeps every physical output muted and ends the call if one becomes audible. Edmund's voice is Kokoro (`bm_daniel`, his mirror voice) in its own sidecar, streamed a sentence at a time, and talking over him stops him.
- A ringing call while Edmund is mid-turn hands the work to a background agent first; the "call ended" event names it so he takes it back.
- Replies are spoken while a call is live and texted otherwise; a reply that could not be spoken falls back to text. Compaction waits until the call ends.
- The virtual microphone is a split driver built from pinned BlackHole 0.7.1 source (`native/facetime/driver/build.sh`): a record-only "Edmund Mic" and a play-only "Edmund Feed", fixed at 48 kHz. With stock duplex BlackHole, FaceTime's measured input level fell from -21.7 to -111 dB within ten seconds of a call; on the split pair it returned to -16 dB each time Edmund spoke, 35 s in.
- Edmund speaks only once FaceTime's audio process is listening on Edmund Mic and playing to a real speaker, read per process from Core Audio. The microphone opens about 2.4 s after a call reports active; before this, the first second of every greeting was lost. A call whose audio never reaches the caller is hung up with an alert naming the device FaceTime used.
- The mirror's speech sidecar and sentence chunking moved to `src/voice/` so both can share them; the mirror behaves as before.
- Tools: `facetime_call`, `end_call`, `call_status`.
