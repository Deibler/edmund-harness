---
"edmund-harness": minor
---

FaceTime calls take turns like a conversation: Edmund answers when you have finished, answers what you said as a whole, and nothing loads while someone is waiting.

- **When you have finished.** The listening helper now notices you pause (an energy voice-activity check on 20 ms frames; Apple's SpeechDetector reported nothing when fed the same speech). It hands the last 8 s of your audio to Smart Turn v3.2 (pipecat-ai/smart-turn, BSD-2, 8.7 MB, pinned by sha256, fetched with `make -C native/facetime turn-model`), which runs locally in a resident sidecar and judges from the audio itself whether the pause ends your turn.
  - **A finished-sounding pause** ends the turn as soon as the transcript is in, and the transcript is asked for at once (`SpeechAnalyzer.finalize(through:)`) instead of after the recogniser's own pause. In a simulation on recorded speech, the final transcript arrived 0.50-0.74 s after the speech ended, against 1.5-2.1 s before, which the old fixed 0.7 s then added to. It is forced only at real turn ends: forced at every pause, it garbled the words on either side ("I'll meet you" came back as "....").
  - **A pause mid-thought** ("and then...", "um") keeps listening for up to 2 s.
  - **No verdict** (no model, a sidecar crash, an older helper) falls back to the old timer.
- **As a whole.** Answering each pause in turn made calls feel like a queue. If you start talking again before Edmund has said a word of his reply, that reply goes unsaid rather than being cancelled, because an interrupt recycles the worker and costs a cold start. The next turn is told what you never heard and answers everything in one reply. The call envelope also asks for a sentence or two, one question at a time, and for several things said in a row to be answered together.
- **Nothing loads mid-call.** On calls Edmund placed, the switch to the call's model happened on his first reply, after they picked up. That left people saying "hello?" into 3.2-6.8 s of silence, plus ~0.5 s to reload the voice. His opening line is now written while it rings, and the voice is warmed when a call starts.
- **Measured.** One `[calls] exchange` line per exchange gives each stage in ms after you stopped talking: pause seen, turn verdict, final transcript, handed to the conversation, Edmund's first words, his first sound.
