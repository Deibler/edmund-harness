---
"edmund-harness": patch
---

Recover from a thread the provider refuses, stop overlapping recovery sweeps, and load Claude Code plugins into workers.

- **A refused thread is dropped, not retried.** "This request was blocked by our safety systems" now classifies as `thread_refused`. The Codex runner forgets the thread the moment a turn is refused, and a healer drops one that was stored anyway, so the next turn starts fresh instead of failing the same way on every resume.
- **A cold recovery turn carries the recent chat**, the way scheduled wake-ups do, so a turn whose thread was dropped knows what was being discussed.
- **One recovery per session at a time.** A sweep that started during another's recovery turn used to answer the same messages again once the lock freed.
- **Recovered messages lose their inbound acks**, so a restart inside the ack window cannot replay them as "you were offline".
- **`[claude] plugin_dirs`** loads Claude Code plugins into every Claude worker and sub-agent that has a shell. Sandboxed and guest workers get none. A directory without `.claude-plugin/plugin.json` fails the boot.
