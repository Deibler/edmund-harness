---
"edmund-harness": patch
---

A conversation that Claude's safeguards refuse now moves to a fresh thread and gets answered, instead of failing every turn, and a failed `/compact` is reported as failed.

- **A refused Claude thread is dropped.** The CLI already retries a flagged turn once and then falls back to the previous Opus. When the fallback's safeguards flag it too ("Opus 4.8's safeguards flagged this message"), the judgment is about the thread's whole history, so resuming it fails the same way. That error used to classify as `unknown`, so recovery retried the same thread; one DM failed four turns running. It now classifies as `thread_refused`, the class the Codex safety refusal already used. `runModel` forgets a refused thread for both CLIs, shuts down the warm worker still holding it, and keeps the caller from restoring the id. Recovery then answers on a fresh thread with the recent chat.
- **No retry on the refused thread.** The Claude runner's in-band heal no longer drops the thread and then resumes that same id. The `thread_refused` healer also evicts the warm worker, because the pool reuses a session's worker whatever id the next spawn asks for.
- **A failed `/compact` is a failure.** The CLI ends a failed compaction with a success result whose text is `Error during compaction: ...`, so the pool logged `/compact ok` and auto-compact logged "applied". Seven compactions of one DM failed that way while its context grew from 209k to 259k. The worker now reports that text as a failure, and a refused compaction re-anchors the thread instead of retrying it every turn.
