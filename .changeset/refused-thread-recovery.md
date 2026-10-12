---
"edmund-harness": patch
---

Recover from a thread the provider refuses, stop overlapping recovery sweeps, and load Claude Code plugins into workers.

- **A refused thread is dropped, not retried.** "This request was blocked by our safety systems" now classifies as `thread_refused`. The Codex runner forgets the thread the moment a turn is refused, and a healer drops one that was stored anyway, so the next turn starts fresh instead of failing the same way on every resume.
- **A cold recovery turn carries the recent chat**, the way scheduled wake-ups do, so a turn whose thread was dropped knows what was being discussed.
- **One recovery per session at a time.** A sweep that started during another's recovery turn used to answer the same messages again once the lock freed.
- **Recovered messages lose their inbound acks**, so a restart inside the ack window cannot replay them as "you were offline".
- **`[claude] plugin_dirs`** loads Claude Code plugins into every Claude worker and sub-agent that has a shell. Sandboxed and guest workers get none. A directory without `.claude-plugin/plugin.json` fails the boot.
- **Security updates** for four advisories at high or critical: `@modelcontextprotocol/sdk` 1.31 (OAuth client could send credentials to a server-chosen authorization server), `proxy-addr` 2.0.8 (IP spoofing through IPv4-mapped IPv6), `sharp` 0.35.5 (librsvg CVE), and `shell-quote` 1.12 via `concurrently` 10.0.6 (command injection in `quote()`). Every MCP server publishes byte-identical tool schemas under the new SDK.
