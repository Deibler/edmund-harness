# persona.example/

**These files are the assistant.** Everything about who it is, how it talks,
what it will and won't do, and what it remembers lives here as plain markdown —
not in the TypeScript. The harness is the machinery; this directory is the
character.

```bash
cp -r persona.example persona
```

`persona/` is gitignored, because a real one fills up with the names, habits,
and history of actual people. This directory is the committed template.

## Why this matters more than it looks

Without `persona/`, the harness still boots, still receives messages, still
replies — with **no identity, no venue rules, and no memory**. Nothing errors.
You just get a generic model with iMessage attached, and it is not obvious from
the logs that anything is missing. Copy the directory before your first run.

## What each file does

| File | Loaded when | What belongs in it |
|---|---|---|
| `IDENTITY.md` | every turn | Name, character, voice. The shortest file that matters most. |
| `SOUL.md` | every turn | Durable memory: who the operator is, recurring facts, the assistant's own evolving opinions. The model appends here over time. |
| `AGENTS.md` | every turn | Operating rules — red lines, tool discipline, when to act vs ask. |
| `HOME.md` | every turn | The physical/situational context it lives in. Delete if not useful. |
| `VENUE_DM.md` | 1-on-1 chats | How to behave in a DM. |
| `VENUE_GROUP.md` | group chats | How to behave with an audience. |
| `VENUE_MIRROR.md` | mirror sessions | Spoken + on-glass venue. Only if the mirror integration is installed. |
| `GHOST.md` | proactive ticks | Rules for messaging someone *unprompted*. Only used when `[brown_nose].enabled`. |

Sub-directories:

| Path | Purpose |
|---|---|
| `people/<handle>.md` | Per-contact memory. Auto-injected in that person's DM. Written by the model. |
| `groups/<slug>.md` | Per-group memory. |
| `orchestrators/<key>/` | Per-orchestrator overrides. Any file here wins over the top-level one; anything absent falls back. |
| `trading/` | Persona for the trading sub-agent. Only if that integration is installed. |
| `sessions/` | Runtime session transcripts. Created automatically — leave empty. |

## Editing

Edits apply on the next turn — no restart. The prompt builder hashes these
files, so changing one cold-respawns the worker rather than serving a stale
cached prompt.

Two habits worth keeping:

- **Write rules as behavior, not aspiration.** "Lead with the answer, skip the
  preamble" beats "be helpful and concise."
- **Keep `IDENTITY.md` short.** It is read every single turn. A page of
  character does more than five pages of instructions.
