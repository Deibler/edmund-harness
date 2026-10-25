---
"edmund-harness": minor
---

Make Edmund finish the job and listen.

- Background passes get their own effort setting (`[claude] background_effort`) instead of inheriting the turn's, so memory updates stop timing out. Consolidation gets a longer timeout, and archiving waits until a due consolidation succeeds.
- An expired Claude login alerts the operator at once and scheduled jobs retry for hours instead of minutes.
- Videos are watched locally (contact sheets the model reads, plus a transcript) and voice notes are transcribed with whisper.cpp first; hosted models are a fallback.
- Lessons Edmund records about subjects now reach conversations through recall, without the names they came from.
- Control words never reach a person; safety check-ins fire on time without the settings footer; proactive fires can be set in wall-clock time.
- Blocked pages are retried in headless Chrome, and an unreadable page is reported as unread instead of guessed at.
- Corrections replace the facts they correct, and dated commitments get a turn the day before that drafts the deliverable.
- Finished sub-agent and background results join a running turn; send_message reports how many messages were just sent.
- A canary checks each new Claude CLI version (the CLI is not pinned) and alerts if an update breaks a path Edmund relies on.
- `edmund review` writes a weekly sheet of reply times, corrections, leaks and real exchanges to mark pass or fail.
- Recurring jobs see how their last sends landed and ask once after three go unanswered.
- Each person gets a shelf: permanent links for what Edmund makes them, served behind the named tunnel (`[shelf] origin`).
- The system prompt teaches finishing the job: say what was checked, flag the risk, hand over somewhere lasting, sketch past the default, and check renders with `blind_check`.
- In groups, an unnamed answer to Edmund's own question wakes him within the hour.
- People can connect their own calendar by its secret iCal link.
