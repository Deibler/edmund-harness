---
"edmund-harness": patch
---

A daemon that dies no longer leaves its turns running to be answered twice.

Turn workers run in their own process group so the daemon can stop a worker's whole tree, which also let them outlive it. After a crash they finished their turns and sent them, while the next daemon replayed the same messages to new workers. One daemon that died 44 times in 26 minutes sent a person 17 messages for 2 requests.

- Each turn worker is written down in `data/turn-workers/` with the daemon that owns it. A watchdog started by the daemon stops them when the daemon is gone, and the next daemon stops any that are left before it serves a send or replays a message. Sub-agents and background jobs are untouched: they are meant to survive a restart.
- The mirror outbox no longer fills for good while the screen is away. State updates never expired, so after nine days offline they reached the 2,000-row cap and every mirror write failed. The expiry sweep failed with them, on a bare timer, and that error is what ended the daemon. The oldest updates now give way, since the snapshot a reconnect begins with replaces them, and a sweep that fails is skipped.
- A printer report that arrives after shutdown has closed the printer's store is dropped. It used to end the shutdown early with an error, before the workers were stopped.
