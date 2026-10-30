---
"edmund-harness": patch
---

FaceTime turn-taking fixes from the first call with Smart Turn live.

- **A reply the caller talked past is held, not dropped.** If what they said becomes their turn, it goes unsaid and the next reply answers everything, as before. If it does not (someone in the background, a cough), it is said after 1.5 s of quiet. Dropping it outright left the caller in 18 s of silence: background talk while Hunter was in bed with Kayla cancelled two replies and never became a turn of its own.
- **A final transcript with no words (".") no longer starts a turn.** That one made Edmund apologise for a reply the caller never heard.
- **The exchange trace starts fresh with each new utterance.** A reply that was never spoken left its timestamps behind and produced `words_ms=-17268`.
- **`[facetime] keep_turn_clips` (off by default) keeps the last 30 clips the turn detector scored, as WAVs named with their scores.** Smart Turn scored two complete sentences from that call 0.12 and 0.01, and it cannot be tuned without the audio. These are recordings of callers, so leave it off except while diagnosing.
