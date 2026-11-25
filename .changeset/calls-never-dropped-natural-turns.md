---
"edmund-harness": minor
---

Calls are not cut off by the daemon, do not open on silence, and leave less dead air. Measured from all 43 calls and 79 exchanges in `data/db/calls.db` and the daemon log, 2026-10-29 to 11-12.

**Calls that were dropped**

- **The memory governor no longer restarts the daemon during a call.** All five calls that ended "Edmund shut down" (5 of the 11 answered since 2026-11-05) were this restart. It deferred to a turn in progress, and between two of a caller's sentences no turn is in progress. A ringing, dialling or connected call now counts as busy (`boot/busy.ts`), and `service.sh stop|restart` refuses while one is up unless `EDMUND_FORCE=1`.
- **The transcriber is loaded for calls, not kept all day.** It held 2.0-2.6 GB for a 1.27 GB model, because MLX keeps every freed buffer; capped at 256 MB it holds 1.5-1.7 GB and transcribes as fast (100-223 ms a clip either way). It now loads when a call starts ringing (1.8 s; the shortest ring so far was 3.6 s) and unloads after ten quiet minutes, never during a call. That resident memory is what had the daemon at its limits: 26 of its 31 restarts ever, and about 100 worker evictions a day, came after calls shipped.
- **A call can no longer stay "live" with nobody on it:** an answered ring that never connects is given up on, a failure while ending still frees the conversation, and a call left up by a daemon that died is hung up when FaceTime next reports in.

**Calls that were silent**

- **The main thread no longer stops for a count.** The recall coverage bar counted indexed documents by reading every artifact row, vectors included: a median 15.6 s (1,893 times, about every ten minutes), with nothing else running. On the 2026-11-07 call that was 22 s of Edmund neither hearing nor speaking. The same count over the primary key's index takes 0.2 s and is checked against the per-kind row count each time. A stall over 500 ms is now logged (`[loop] main thread stopped`), with whether a call was up.
- **The recall indexer stands down for the length of a call.** Its tick walks every sandbox on the main thread: 1.2-2.1 s once a minute, which the new stall log showed within minutes of going live. It works from watermarks, so it catches up on the tick after the call.
- **Someone never texted can be called.** The "it is ringing, write your opening line" wake-up was skipped for a conversation with no session record, so they picked up to 10 s of nothing (2026-11-06, 11-11). The record is made as the call begins.
- **"Hello?" when the opening line is not ready.** If nothing has been said 1.2 s after they can hear Edmund, the line says `[facetime] opener` and his own line follows.
- **A reply written before the call is a text again.** Asked "call me", Edmund's "Calling you now." was held and spoken as the first thing heard on pickup.

**Turn-taking**

- **A sound of thinking while a reply is slow** (`thinking_sounds`, after `thinking_sound_after_ms`): only into silence, only for a turn of three words or more, never the same one twice running, and never counted as his reply in the exchange log (`aside_ms` beside an unchanged `gap_ms`).
- **"Uh-huh" over Edmund does not stop him**, and "yeah" while he is still speaking is not a turn until he has stopped; it joins what they say next. A single "stop" or "wait" does stop him.
- **A long opening sentence starts at its first clause**, and a caller's turn is no longer held 250 ms by the pipeline's voice window after the call's own turn-taking has ended it.
- **The call envelope asks for one or two short sentences** with the reason, a short first sentence, and spoken numbers: replies to "a sentence or two" averaged 330 characters on the 2026-11-05 calls.
- **Quiet on both sides is noticed** (`quiet_check_seconds`): Edmund is told and decides whether to check in, say where things stand, or end the call.

**From the first two live calls (2026-11-12)**

No drop, no stall and no restart on either, and the gap to Edmund's first sound was 1.8-3.6 s (12 exchanges, median 2.7 s) against 4.8 s before. They also showed what the tests had not:

- **The sound of thinking and the quiet check had never fired.** Both waited for the ear to say the caller had stopped talking, which it never says: a pause and its words are how it says so. The tests now send a stretch of speech exactly as the ear does, and the ear's own test pins that it reports starts only.
- **A wake-up on a call is told it is on a call.** The first turn of every call Edmund places is a wake-up, and wake-ups were the one kind of turn without the call's block. Asked to write his opening line while it rang, he called `facetime_call` again and wrote what he was doing, which is what the person heard on picking up. The ringing wake-up now says the call is placed and the reply is the line itself, and `facetime_call` refuses at once while any call is up.
- **A report for whoever asked for a call no longer goes to the person called.** The call's block said send_message texts "them (or anyone else)"; it now names who it reaches and points to message_contact. The conversation that asked is given what was said when the call ends, instead of being told only that it ended, and the call's own conversation is told there is nothing to report.
- **The transcript is a second opinion on the turn detector.** Scored unfinished but transcribed as a finished sentence (29 of the 35 unfinished verdicts across 91 exchanges), a pause waits 250 ms, not 800.
- **"Uh" by itself is not a turn.** It waits up to 4 s for the rest and joins it.
- The sound of thinking now waits 2 s by default, not 1.5: at 1.5 it would have preceded nine of ten replies on the first call.

**The voice says the words it is given (2026-11-12)**

- **Kokoro is fed the phonemes it was trained on.** kokoro-onnx phonemizes with espeak unless handed phonemes, and espeak writes a different alphabet from the misaki one Kokoro v1.0 learned (a diphthong as two vowels, `ɚ` for `əɹ`, its own guesses at names). On 200 sentences Edmund had said on calls, transcribed back by Parakeet, 49 of 2,229 words came back wrong from espeak's phonemes and 31 from misaki's: better on 18 sentences, worse on 3. "Yeah." alone was inaudible; "Yeah, ..." was heard as "Yay", "Ha, ..." as "How". The sidecar now phonemizes with misaki (`src/voice/pronounce.py`) and says which at boot (`kokoro ready phonemes=misaki`); without misaki installed it speaks from espeak as before. `scripts/install-kokoro.sh` adds it without its `[en]` extra, which brings torch for a tagger never loaded. The voice process went from 519 MB to 714 MB.
- **A word can be given its pronunciation.** `data/calls/pronounce.json` maps a word to misaki phonemes and is read again whenever it changes. "Hmm" is built in: misaki's lexicon writes it without a vowel and Kokoro made noise of it.

**A faster voice, chosen in the voice lab (2026-11-12)**

- **Calls can speak with Phonon 31m** (`gradium/phonon-31m-en` through `ptts`, Apache 2.0; `src/voice/phonon-sidecar.py`). A voice setting is now a Kokoro voice or blend as before, or one of Phonon's catalog voices as `phonon:Micah`; the lab lists both and the name says which engine speaks. Measured on the M4 on 200 sentences Edmund had said on calls, in each of three voices: a whole sentence in a median 124 ms (p90 200, worst 340) against Kokoro's 686 ms; 38 to 48 of 2,229 words transcribed back wrong against Kokoro's 31; no sentence repeated or ran on. Four open models were tried: Pocket TTS was as accurate at 80 ms to first sound and 0.8-1.1 GB; ZONOS3-Mini, the only one with emotion controls, took 2.76 GB and repeated itself on 2 of 60 short lines.
- **On the CPU**, where a sentence took 109 ms against 267 ms on Metal, and off the GPU a call's hearing runs on.
- **Its pads are cut.** Phonon leaves a median 0.14 s of near-silence before a sentence and 0.63 s after; 50 ms and 120 ms are kept. Transcribed back, the trimmed clips had 37 wrong words to the untrimmed 38 and no more first or last words lost.
- **Speed is Phonon's own pace control** (`duration_delta = -ln(speed)`, held to the +/-0.5 that was tried: about 0.8x to 1.4x).
- **Kokoro is the understudy, not a second resident.** Each engine is its own process. The one whose voice is in use stays loaded; the other loads when asked for (a lab preview, a line Phonon could not say, a `call_voice` choice) and unloads after 15 quiet minutes. With a Phonon voice in use the voice process holds 238 MB where Kokoro held 714 MB. A line Phonon cannot say (process down, voice not cached and no network, the model running on twice) is said by Kokoro in `kokoro_voice`, and logged.
- **Speech far too long for its text is thrown away** and tried once more with another seed (Phonon reads a text identically every time otherwise), then handed to Kokoro.

Not changed: the model default. With a call-sized cached context, Sonnet's first word took 1.4-2.0 s and Haiku's 0.9 s through the same CLI path (three warm turns each). `[facetime] model` is where to set it.
