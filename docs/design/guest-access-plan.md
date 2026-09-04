# Keyed guest access — design plan

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

**Status:** approved for implementation
**Author:** the operator, with Claude Code, 2026-08-10

## Problem

The DM gate is a binary allowlist. Unknown senders are silently dropped. The
operator wants to publish the assistant's iMessage address to an outside
audience (a portfolio, an event, a mailing list) so that strangers can talk to
it. Those people must reach the full experience without gaining access to the
operator's personal data or integrations, and without opening the door to
arbitrary strangers.

## Concept: campaigns

A campaign is a configured bundle: an access key, a context markdown file, and
limits. One campaign per audience. Example: a portfolio campaign with key
`opensesame2026` and context `campaigns/example.md`.

## Access tiers

1. **operator / allowlisted** — existing behavior, unchanged. Full Edmund.
2. **vouched** — a handle that shares a *registered* group chat with Edmund may DM
   him without a key. Full persona, conversation-scoped memory, guest tool surface.
3. **keyed guest** — an unknown DM sender who includes an active campaign key in
   any message. Full persona + campaign context, conversation-scoped memory, guest
   tool surface.
4. **unknown** — everyone else. Messages buffered, never sent to the model.

Group gating itself is unchanged (registered groups + mention rule).

## Required behavior

### Gate (extend `src/gating/allowlist.ts` + call site in `src/channels/turn.ts`)

- `gateInbound` gains tier awareness. Return the tier with the allow decision so
  downstream session assembly knows what to build. Keep the existing `Gate` shape
  backward compatible (add fields; do not break existing tests unnecessarily).
- DM from unknown handle:
  - If handle has an active guest activation → allow as `keyed-guest`.
  - Else if handle is vouched → allow as `vouched`.
  - Else → buffer the message (persist), scan text case-insensitively for any
    active campaign key. On match: persist activation {handle, campaignKey, ts},
    alert the operator ("<label> key activated by <handle>"), and process this
    turn INCLUDING the buffered pre-key messages as clearly-labeled untrusted
    context. No match: stay silent (no reply), record the attempt for the
    dashboard/decisions log, and cap the buffer per handle (keep last ~20
    messages, 14-day TTL).

### Vouching

- When a message arrives in a registered group, record every participant handle
  as vouched (persist; normalized via `normalizeHandle`). Vouching is by
  co-membership in a registered group, not by whether Edmund replied.

### Persistence

- Follow repo conventions for small SQLite stores in `data/` (e.g. a
  `data/guests.db` or a table in the existing state store — implementer's choice,
  match existing patterns): tables for activations, vouched handles, buffered
  messages, and per-campaign daily counters.

### Config (`src/config/config.ts`, zod)

```toml
[guest_access]
enabled = true            # global kill switch; false = current behavior exactly

[[guest_campaigns]]
key = "opensesame2026"
label = "Portfolio reviewers"
context = "campaigns/example.md"
expires = "2026-11-01"        # optional ISO date; expired = key inert AND replies stop
max_spend_usd = 25            # optional, per campaign lifetime, via spend ledger
max_messages_per_day = 40     # optional, per campaign per day
```

- Validate at config load: context file must exist and be readable; duplicate keys
  rejected; key matching is case-insensitive, keys must be >= 8 chars.

### Session assembly (guest + vouched tiers)

- FULL Edmund persona — same persona, voice, self-knowledge as the operator gets.
  This is a demo of the real Edmund, not a stripped mode.
- Keyed guests additionally get the campaign context file appended to the system
  prompt as a clearly delimited section ("Campaign context (operator-authored,
  trusted): ...").
- Conversation-scoped memory only. HARD exclusions, enforced structurally (the
  tools simply are not registered for these sessions, not prompt-forbidden):
  - no semantic memory / history search over the operator's messages
  - no people profiles / annotate store
  - no integrations (trading, mirror, radaromega, fishing, cloudflare-browser)
  - no cron/trigger creation, no missions, no deep-research spawning
  - no send/typing tools that could message anyone other than the guest's own chat
  - no filesystem/skills execution beyond what a plain conversational turn needs
- Ghost/proactive: guest and vouched handles are never ghost-outreach targets.
- Session keys: reuse the existing per-contact session scheme so a guest gets a
  persistent conversation across days (until campaign expiry).

### Caps and safety

- Per-handle rate limit (e.g. 10 messages / 10 min rolling; configurable constant).
- Per-campaign `max_messages_per_day` and lifetime `max_spend_usd` measured via the
  spend ledger (tag guest turns with `subsystem: "guest"` and the campaign key, or
  follow whatever tagging pattern the ledger supports).
- On cap hit: one polite short decline, then silence; operator alert once.
- Campaign expiry ends both new activations and further guest replies.
- `guest_access.enabled = false` restores the exact current gate behavior.

### Tests

Match the existing suite style (bun test, tests/ directory). Cover at minimum:
tier resolution for each path; key detected in first and in Nth message; buffered
messages included after activation; no activation for expired/unknown keys;
case-insensitive matching; vouch recording from registered-group traffic and
vouched DM admission; caps (rate, daily, spend) and expiry; kill switch parity
with old behavior; structural assertion that guest sessions expose none of the
excluded tools; operator alert fired on activation. Keep the whole suite green.

### Campaign file

Create `campaigns/<name>.md` as front-matter-free markdown written for the
model: who is likely on the other end, what the assistant is to them, what to
emphasise when asked, and the boundaries (never the operator's personal life,
other people, message history or spend; say plainly when something is out of
scope; be open about being an AI). `campaigns/example.md` is the tracked
template. Real campaign files are gitignored because they describe a real
audience.

### Docs

Update README's gating section briefly. This plan file ships with the change.

## Out of scope

- Dashboard UI for campaign management (config file is fine for now).
- Multi-key-per-campaign, invite links, SMS fallback.
