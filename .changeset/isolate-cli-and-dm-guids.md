---
"edmund-harness": patch
---

Edmund's model calls no longer read the operator's own Claude Code setup, and DM sessions the relay created carry their real chat guid.

- **No operator instructions in Edmund's prompt.** Every Claude Code process the harness starts ran inside this checkout and read the CLAUDE.md files found walking up from its cwd (the repo's developer notes and `CLAUDE.local.md`), `~/.claude/CLAUDE.md`, the auto-memory index and the user-scope plugins. Measured 2026-10-23: about 25k tokens of that reached every cold turn, in DMs and groups. Turns, sub-agents and one-shots now pass `--setting-sources ""` and state what they need in `--settings` (auto-memory off, thinking on as before).
- **One-shots run without tools they never needed.** The ghost, pre-screen, maintainer, consolidator, curator, catch-up, planner and eval calls read text other people wrote, with `bypassPermissions`, every built-in tool and the operator's MCP servers and claude.ai connectors (Google Drive and Stripe among them). They now load only the MCP servers they name and no built-in tools unless they name them (catch-up keeps `Read` for attachments; the ghost tick, which has its own MCP config, is unchanged). Their transcripts are no longer written into the operator's project history.
- **DM sessions the relay created are visible again.** The relay stored a bare handle as the chat guid when it pre-created a DM session, and nothing corrected it. Seven sessions (six active) were invisible to the person-file maintainer, the ghost's outcome scoring and the recovery sweeper. The relay now stores the chat.db guid, an upsert replaces a bare handle with the real guid, and boot repairs existing rows from chat.db.
