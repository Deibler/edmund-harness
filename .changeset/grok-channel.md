---
"edmund-harness": minor
---

Talk to Edmund from Grok, the voice assistant in a Tesla.

- A remote MCP server (streamable HTTP, stateless) exposes four tools. `ask_edmund(message)` runs a real turn as the configured person inside their own iMessage DM session (one conversation, one memory) and returns a one-to-three sentence answer written to be read aloud; while it waits it sends MCP progress notifications if the caller sent a progress token. `tell_edmund(message)` queues a turn and returns at once, the answer is texted. `check_edmund()` runs no turn: whether Edmund is working, the answers he texted after a slow line, and a one-line printer status when printing. `report_to_edmund(reply_id, result)` is how a Grok Bot hands a finished task back: unknown or expired ids are refused, a valid one wakes Edmund in the DM.
- A connector request is the person asking (Grok bots, even a deliberately dumb one, relay their own words): Edmund acts on it as on a text from them, outward-facing and paid actions included, takes the likeliest reading of a garbled relay or asks back. A Bot's `report_to_edmund` result is the one exception: it is work product, not instructions.
- Edmund can hand a task to a Grok Bot: `grokbot_task(task, bot?, wait_for_result?)` POSTs to a webhook configured under `[grok.bots.<name>]` (`webhook_url`, `key`; config.toml only, never logged), records the reply id for 24 h, and is registered only where the owner is: their own DM session and iMessage groups they are in (hidden from other DMs, groups without them, SMS groups, guests and sub-agents). The session it was asked from is stored with the task, and the Bot's report wakes Edmund there: the group chat, or the owner's DM when none is recorded. See "Set up a Grok Bot routine for Edmund" in `docs/grok-channel.md`.
- Sends and attachments from that turn land in the person's iMessage DM. Past `answer_timeout_ms` (25 s) the call returns "Edmund's working on it, he'll text you the answer" and the reply is texted when it is ready.
- Whether a reply is spoken on the line or texted is decided per turn from that turn's batch: a turn for an ordinary text is untouched, a mixed batch is spoken and texted.
- Auth is a long random `[grok].token`, accepted as a bearer header, a `?key=` parameter, or both (`auth_mode`). Failed attempts, request rate, turn rate and message size are all capped.
- A quick-tunnel launchd service exposes it: `scripts/launchd/service.sh grok-tunnel install`. See `docs/grok-channel.md`.
