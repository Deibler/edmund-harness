---
"edmund-harness": patch
---

A resumed conversation sees today's memory, recall no longer stalls the daemon, and the docs stop describing a write guard that never ran.

- **Resumes render the current prompt.** Since about CLI 2.1.287 a conversation recorded its system prompt on the first request and resent that record on every resume until it compacted, ignoring the prompt the harness passed. The person file and SOUL.md are in that prompt, so over 7 days (2,330 turns) the median turn ran on memory 1.7 h old, the 75th percentile 13.6 h, and 13% of turns on memory over a day old. Workers now pass `--system-prompt-snapshot off`; an unchanged prompt still reads from cache, and a persona edit reaches a cold resume on its next turn again.
- **The daemon keeps its recall cache.** It was evicted after 10 idle minutes and reloaded in one synchronous block, up to 31 s from a cold disk: 19% of turns over 14 days waited more than 5 s, every other chat with them. The daemon now keeps it and loads it at boot in slices (longest block 0.9 s on the live index). The cache no longer holds row text, which only the returned hits need: 0.6 GB instead of 1.4–1.6 GB, and searches run in 21–109 ms instead of 80–323 ms.
- **No phantom guard.** `.claude/settings.json` declared a write guard and a media-delivery hook. Workers read project settings only from their own sandbox, so neither ever ran, while the docs, comments and the prompt ("A path guard rejects Write/Edit/Bash mutations outside the sandbox") said it did. Enabling it would have blocked about 1,200 of 20,000 worker writes a month, much of it ordinary work in `/tmp`, and the delivery hook would have double-sent media the model already sends. Both are removed and the text describes the real boundary: `disallowedBuiltinTools` and the MCP server's path checks.
- **Ghost outcomes read every chat of a person.** The outcome sweep looked for a reply only in the chat row the session recorded, so a reply from a person's other address scored the fire as ignored.
- **A bad `agent_model` shows at boot.** The startup self-check validated only the main model; a malformed sub-agent model surfaced as one failed `spawn_agent` after another.
