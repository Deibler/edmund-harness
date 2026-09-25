---
"edmund-harness": patch
---

A turn is no longer ended by a result that belongs to a turn the CLI started itself. When a session is resumed after its last process was killed with a background shell running, the CLI first delivers a "stopped" notification as its own turn and prints a result with `num_turns` 0. That happens before it reads our message. On 2026-09-25 that result ended a turn after 1 second. The model kept working untracked, and the memory governor evicted the "idle" worker in the middle of a render.

Workers now:
- pass `--replay-user-messages`;
- stamp each message with a uuid;
- skip a result with `num_turns` 0 that arrives before that message's echo.

This applies to both the resident worker and the per-turn process.
