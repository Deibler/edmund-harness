---
"edmund-harness": minor
---

A security watch for the assistant's own tool calls. Under full host access the likeliest harm is the assistant doing something it should not, because a page told it to or because it made a mistake. The watch restricts nothing in a normal turn and wakes when a tool call trips a rule.

- **Every tool call is seen.** Workers and sub-agents are started with Claude Code HTTP hooks that send each call to the daemon before and after it runs, about 3 ms a call. A call that reaches outside the machine is written to a new `flight` log channel, and a first contact with a site is noted.
- **Tripwires, then a judge.** A canary on its way out, or a real credential in a message to a stranger, is refused. A call that cannot be undone (a credential to a new site, data sent after a credential was read, a text to someone outside the chat after reading a web page, fetched or decoded code about to run) waits for a small model that is shown what was asked and what the turn did. Everything else runs and is judged afterwards. Serious stops the turn and pauses the chat. No verdict in time lets the call run.
- **Secrets are known by value.** Every credential in the config, the secrets folder and `.env` is recognised as itself and in base64, hex and URL-encoding. Two canaries are planted at first start.
- **Alerts that can be answered.** The operator is texted what happened, where and what was done, and replies `OK <id>`, `UNDO <id>` or `LOCKDOWN`. The reply is acted on before any model sees it.
- **Lockdown.** `edmund lockdown` (or the text) closes every quick tunnel and share, takes the shell from workers, messages only the operator and turns the web tools off. `edmund lockdown off` puts it back.
- **A publish gate.** A share is refused before it starts when its expiry is missing or past `[watch] max_share_days`, or when its folder holds a credential file, a canary, a real credential or a vendor's key format. A tunnel or listener that appears without going through the gate is an incident, and is closed if the assistant started it.
- **`[watch] mode`** is `observe` by default: everything above is recorded, judged and alerted on, and nothing is stopped. Set `enforce` to have it act.
- `edmund watch` shows what it is doing; `scripts/watch-replay.ts` replays the rules over the transcripts on disk and counts what they would have done.
- **Who is knocking.** The daemon reads every server's request log and keeps a fading score for each outside address, with reputation lists downloaded whole and looked up locally. A high score is blocked for a day without a word, at every harness server and every share's own. The judge reviews a visitor only for harm or persistence: something got through, a key was guessed, a payload was aimed at a real page, refusals keep coming, a subnet floods, an address keeps coming back.
- **The change watch.** LaunchAgents, the crontab, shell profiles, `authorized_keys`, cloudflared's config and `config.toml` (as key names and fingerprints, never values) are compared every five minutes, with the earlier version kept to restore.
- **A drill.** `edmund watch drill` runs four scenarios through the live watch and texts the result; it repeats every 30 days.
- `edmund logs traffic` counts requests from this machine's own public address as its own.
