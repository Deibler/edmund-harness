# Brown-nose mode — design & build plan

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

**Status:** planning · author: assistant · created 2026-05-13

A two-tier proactive system. A cheap continuous **ghost model** observes
each session and decides if/when the main model should wake up unprompted.
The **main model** never wastes a token deliberating "should I act?" — it
only ever runs because the ghost already said yes. When main runs, it has
final veto and decides the actual content of the move.

Built so a misfire is cheap and reversible: defaults off for groups,
hard caps everywhere, explicit user-controllable preferences, never
auto-re-enable after a push-back.

---

## Research grounding

Three findings drove the architecture:

- **ChatGPT Pulse's failure mode** is that a one-time interest becomes a
  recurring daily card. Predictable scheduling = annoyance vehicle.
  *Conclusion: the model picks the moment; never a fixed time.*
- **Inner Thoughts (Liu et al., ICLR 2026)** showed an 8-heuristic
  participation model (relevance, info gap, originality, balance,
  coherence, dynamics, expected impact, urgency) where the agent decides
  *whether* to contribute by computing an intrinsic motivation score.
  *Conclusion: the ghost prompt is built around an "intrinsic
  motivation" check, with explicit reasons-to-act and reasons-to-back-off
  surfaced before the call.*
- **Heartbeat-driven cognitive scheduling (2026)** — separating long-
  horizon "Planner / Critic / Recaller / Dreamer" thinking from the
  reactive agent. The ghost plays the Planner+Critic role; main plays
  the reactive agent.
  *Conclusion: ghost is event-driven (mostly) with a periodic backstop;
  outputs structured decisions with scheduled fire times.*

Sources cited inline in the conversation thread that drove this plan.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Triggers (any of these wake the ghost for a session):          │
│    • main just replied                                          │
│    • session has been quiet N hours (4h / 24h thresholds)       │
│    • start of active window crossed                             │
│    • periodic sweep every 2-4h per active session               │
│    • daemon startup                                             │
└───────────────────────┬─────────────────────────────────────────┘
                        ▼
              ┌─────────────────────┐
              │  Ghost (Haiku)      │
              │  reads context,     │   per-session sandbox:
              │  budgets, prefs;    │   /sandbox/<id>/brownnose/
              │  writes notes &     │     ├── current.md  (live thinking)
              │  decision to       ─┼─►   ├── decisions.jsonl
              │  /brownnose dir     │     ├── drafts/
              │                     │     └── research/
              └──────────┬──────────┘
                         │
              {act: false} → log to decisions.jsonl, done
                         │
              {act: true, fireAtMs, brief}
                         ▼
                ┌─────────────────┐
                │  Cron store     │  (existing infra; kind=brown_nose)
                │  scheduled at   │
                │  fireAtMs       │
                └────────┬────────┘
                         ▼ (at fireAtMs)
              ┌─────────────────────┐
              │  Fire → builds      │
              │  proactive envelope │
              │  with the brief     │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │  Main (Sonnet)      │
              │  • reads brief +    │
              │    current state +  │
              │    ghost's notes    │
              │    in /brownnose    │
              │  • KEEP_QUIET or    │
              │    actual action    │
              └─────────────────────┘
```

### Two layers of "no"

- **Ghost veto** (default, ~95% of ticks): never enqueues anything.
- **Main veto** (at fire time): brief looked good when ghost wrote it,
  but context has shifted — user is mid-conversation, just replied
  about something else, etc. Returns `KEEP_QUIET` and the budget is
  charged-but-not-spent (no actual outbound).

---

## Components

### `src/ghost/observer.ts` — event listeners + sweep
Subscribes to:
- `onMainReplied(sessionKey)` — fires after sendDeliver succeeds
- `onSessionQuiet(sessionKey, dur)` — fires from a timer wheel at 4h and 24h marks
- `onActiveWindowStart(sessionKey)` — fires at the per-session window start
- Periodic sweep — every 2-4h, randomized, for every session with brown-nose enabled

Each call → `runGhost(sessionKey, trigger)`.

### `src/ghost/think.ts` — ghost prompt + Haiku call
1. Loads per-session prefs (active window, cooldown multiplier, focus
   suggestions, recent decisions). Also reads global `intensity` and
   resolves it to the row in the intensity table.
2. Pre-flight budget check using the **intensity-resolved** cooldown
   and weekly cap. If blocked, write a one-line decision
   (`act:false, reason:"cooldown"`) without invoking Haiku — saves the
   spend.
3. Builds the ghost prompt with:
   - Recent chat history (speaker-tagged, same format as main)
   - Person file (if DM)
   - Time/day context (current TZ-aware)
   - Last 5 ghost decisions for this session (so it doesn't repeat)
   - Last 3 outcomes (how user reacted to recent brown-nose moves)
   - Active "focus suggestions" the user provided ("focus on X instead")
     with a usage counter — ghost is told to use them, but lightly
   - Notes from `brownnose/current.md` (ghost's own running scratch)
   - **Eagerness clause** from the intensity table (e.g. for level 2,
     the line is "you are at intensity 2 — be very picky; act only on
     unmistakable hooks"). Same prompt, different threshold language.
4. Calls Haiku with structured output schema
5. Parses → `GhostDecision`. Writes to `brownnose/decisions.jsonl` either
   way (telemetry).
6. If `act: true`:
   - Apply schedule jitter: `fireAtMs += randomBetween(jitter_min,
     jitter_max)` to break cross-session clustering at schedule time
   - Clamp jittered fireAtMs to remain inside the session's active
     window (if jitter pushes outside, snap to the window end minus
     5 min)
   - Enqueue cron row
   - Optionally create working files in `brownnose/drafts/` or
     `brownnose/research/`.

### `src/ghost/budget.ts` — limits + decay
- Per-session cooldown: 24h default, doubles on negative engagement,
  triples on second negative
- Weekly cap: 3 default, halved after engagement decay activates
- Active hours check: M-F 9-19 Eastern default
- Just-replied gate (1h): also enforced at fire time
- Quiet-day signal (48h): ghost biased down
- Focus-suggestion overuse: when ghost acts on a user-supplied focus
  suggestion, that suggestion's usage counter increments. If it crosses
  3 uses in a week, ghost is told to back off that topic (the user
  warned: over-relying triggers a turn-off).

### `src/ghost/prefs.ts` — per-session preferences
Stored in state.db (new `brown_nose_prefs` table):
```sql
CREATE TABLE brown_nose_prefs (
  session_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  active_hours_json TEXT NOT NULL,  -- structured per-day schedule
  timezone TEXT NOT NULL,           -- IANA name
  weekly_cap INTEGER NOT NULL,
  cooldown_multiplier REAL NOT NULL DEFAULT 1.0,
  -- focus_suggestions: array of {topic, usage_count, expires_at_ms}
  focus_suggestions_json TEXT NOT NULL DEFAULT '[]',
  -- disabled_reason: free text from main when ghost was turned off
  disabled_reason TEXT,
  disabled_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
```

### `src/ghost/queue.ts` — uses existing cron store
Brown-nose decisions become rows in `cron_jobs` with `kind="brown_nose"`,
`payload_json={ brief, tags, expiresAtMs, ghostDecisionId }`. Scheduler
fires them; `proactive/fire.ts` is the handler.

### `src/proactive/fire.ts` — wake main with the brief
1. Loads the queued brief from the cron row
2. Re-checks budgets (could have changed since ghost wrote the decision)
3. Re-checks just-replied gate
4. **Concurrency check**: acquires the global fire semaphore. If
   `inFlightCount >= max_concurrent_fires`, the cron row's `fireAtMs`
   is bumped by a random offset in `[fire_defer_min, fire_defer_max]`
   minutes and the handler exits without firing. The scheduler will
   re-fire when the new time arrives.
5. **Stagger check**: if any other fire completed within the last
   `min_seconds_between_fires`, defer the same way. Guarantees a
   minimum spacing even when the cap isn't saturated.
6. Loads ghost notes from `brownnose/` for the session
7. Builds a normal envelope with `kind="proactive_opportunity"` and the
   brief attached
8. Invokes main via the existing `runClaude` path (same model, same
   tools, same persona — just an extra envelope field)
9. Logs the outcome to `brownnose/decisions.jsonl`
10. Releases the semaphore; updates the "last fire completed" timestamp
    for the stagger check

The semaphore is a simple in-memory counter on the daemon process,
guarded by a Promise queue. Survival across daemon restart isn't a
concern — if the daemon dies mid-fire, the cron row's `attempts`
counter handles redrive via existing scheduler retry logic.

### `src/channels/envelope.ts` — envelope kind field
Add:
```ts
kind?: "user_message" | "proactive_opportunity";
proactiveBrief?: string;   // ghost's writeup of why now
proactiveContextFiles?: string[];  // paths into /brownnose dir
```

When `kind === "proactive_opportunity"`, the envelope renders with a
clear header so the model knows it's NOT replying to a user message:

```
[Proactive opportunity · Fri 2026-05-15 16:12 Eastern]
The ghost recommended you consider acting now. Brief follows.
Decide: act, or KEEP_QUIET.

Brief:
<ghost's paragraph>

Working notes & drafts the ghost left for you:
  /sandbox/dm_xxx/brownnose/current.md
  /sandbox/dm_xxx/brownnose/drafts/saturday-hike-forecast.md

[recent chat context follows in normal format]
```

### `src/mcp/tools/brown-nose.ts` — model & user-facing controls

Tools the main model can call (which a user can also invoke verbally —
the model translates "stop brown-nosing me" into the right tool call):

| Tool | Purpose |
|---|---|
| `set_brown_nose(enabled?, active_hours?, weekly_cap?, timezone?)` | Update prefs for the current session |
| `disable_brown_nose(reason)` | Hard-off for this chat; records the reason so ghost won't get confused later; never auto-re-enables |
| `enable_brown_nose()` | Re-enable after a previous disable |
| `add_focus_suggestion(topic, duration_days?)` | "focus on X instead" — ghost is told to bias toward that topic (carefully — 3-strikes-and-out per topic per week) |
| `clear_focus_suggestions()` | Reset all user-supplied topic biases |
| `query_ghost(question)` | Inspect: "why did you suggest X yesterday?" / "what are you tracking for me right now?" — reads recent decisions.jsonl and asks ghost (Haiku) to summarize answer |
| `ghost_status()` | Quick snapshot: enabled? next eligible window? last decision? weekly count? cooldown state? |

The user-facing examples:
- Jordan: "stop brown-nosing me in this chat" → main calls
  `disable_brown_nose("user said stop in DM 2026-05-15")`
- Jordan: "actually do that more, but focus on dev stuff" → main calls
  `add_focus_suggestion("software development & projects")`
- Jordan: "wait why'd you randomly send me that hike thing?" → main
  calls `query_ghost("why did you fire the hike forecast brief on
  2026-05-15 16:12?")` and reports back

### `persona/GHOST.md` — ghost system prompt (NEW)

Short, surgical. Not the full Edmund persona — the ghost is a *scheduler*,
not a participant. Key sections:

```
You are a scheduling observer for an iMessage assistant named Edmund.
You see one chat at a time. You never speak to the user. You write
structured decisions that determine whether Edmund will wake up
unprompted.

Default to {act: false}. Acting is rare and earns its place.

Reasons that DO warrant acting (you must see one in the live context,
not just be reminded of it):
  • A fresh, time-sensitive hook (weather, scheduled event, deadline)
  • An open promise/item from a prior turn that's gone stale
  • An artifact you could produce that materially helps a stated goal
  • Genuine social timing (Friday afternoon → weekend plans the user
    mentioned, etc.)

Reasons to back off (any of these = {act: false}):
  • You suggested something similar in the last 7 days
  • User showed disengagement (one-word replies, ignored last attempt)
  • User has been quiet for >48h
  • User just replied <1h ago — let them breathe
  • The hook is "recency" alone (a long chat 2 days ago is not a reason)
  • You can't write a brief in 2-3 sentences explaining WHY now WHY this

Inner Thoughts checklist for go/no-go (Liu et al., 2026):
  1. Relevance — does this connect to a stated interest, or am I reaching?
  2. Information gap — is there something the user doesn't have that I do?
  3. Originality — would my suggestion just repeat what's been said?
  4. Balance — am I dominating this chat's recent rhythm?
  5. Coherence — does this fit the ongoing thread, or barge in?
  6. Dynamics — is the chat winding down or active?
  7. Expected impact — will the user actually use this?
  8. Urgency — does this need to happen now vs in 3 days?

Output JSON only. Schema follows.
```

### `persona/VENUE_DM.md` & `persona/VENUE_GROUP.md` — main model section
Add a section: **"Brown-nose envelopes"**. Tells main:
- You may receive an envelope with `kind: proactive_opportunity` and a
  brief from the ghost.
- This is unprompted; the user did NOT just message you.
- Ghost notes are in `brownnose/`. Read them.
- You have final veto: respond `KEEP_QUIET` if the moment has shifted.
- If user reacts negatively to a proactive move, call
  `disable_brown_nose(reason)` and write a feedback memory.
- If user says "focus on X instead," call `add_focus_suggestion(topic)`
  AND know that ghost will bias to that topic carefully — over-using
  the suggestion will get the whole feature turned off.

### `persona/AGENTS.md` — one core rule
> When a proactive outreach is met with annoyance, turn off brown-nose
> for that chat (`disable_brown_nose`) AND record a feedback memory.
> Never auto-re-enable — the user must explicitly say so.

---

## The `/brownnose` sandbox subdir

Per-session at `sandbox/<id>/brownnose/`. Auto-created by the ghost
observer on first tick. Layout:

```
brownnose/
  current.md          # ghost's live scratch — running notes,
                      # current themes being tracked, weather watch
                      # items, open hooks. Overwritten each tick.
  decisions.jsonl     # append-only log of every ghost decision
                      # (act:false also logged for telemetry)
  drafts/             # in-progress drafts ghost prepared in advance
                      # (e.g. a Saturday-vs-Sunday hike comparison)
  research/           # fact-gathering ghost did during off-hours
                      # (forecast, news article, restaurant menu, etc)
  by-hook/            # organized by what the hook was — useful for
                      # the model to see "what have I been tracking
                      # about Jordan's hiking plans?"
```

Main model has full read access. The persona is told to read
`current.md` first when a `proactive_opportunity` envelope arrives —
that's the ghost's "what I was thinking" file.

This directory is **also where main writes things back if the action
produces an artifact** (the generated webpage, the rendered PDF, etc.)
so the next ghost tick can see what was already done and not double-up.

---

## Active hours format

JSON in state.db. Default for a new DM session:

```json
[
  {"dow": "mon", "start": "09:00", "end": "19:00"},
  {"dow": "tue", "start": "09:00", "end": "19:00"},
  {"dow": "wed", "start": "09:00", "end": "19:00"},
  {"dow": "thu", "start": "09:00", "end": "19:00"},
  {"dow": "fri", "start": "09:00", "end": "19:00"}
]
```

Saturday & Sunday default to no window (ghost cannot act).

User can update via natural language → `set_brown_nose` tool. E.g.:
- "you can do it weekends too, but not before noon" → ghost adds
  sat/sun 12:00-19:00
- "stop doing it during work hours" → ghost shrinks each weekday window
- "only fridays" → ghost reduces to fri-only

Group sessions default to **all-zero windows + enabled=false** (so even
if someone toggles enabled, no window exists yet).

---

## Config (`config.toml`) — global defaults only

```toml
[brown_nose]
# Master switch. False disables ghost entirely across all sessions.
enabled = true

# Intensity slider 1-10. ONE knob that scales cooldown, weekly cap,
# sweep cadence, and the ghost's eagerness threshold together. See
# the intensity table below for what each level means in practice.
#   1  = once in a blue moon
#   5  = balanced (default)
#   10 = frequent — every active user likely gets something most weeks
intensity = 5

# DMs default to brown-nose on with the standard M-F 9-7 ET window.
dms_enabled_by_default = true

# Group chats default OFF. To turn one on, use the set_brown_nose tool
# in that chat (or edit the row in state.db directly).
groups_enabled_by_default = false

# Ghost runs Haiku — cheap, fast. Override if you want to use Sonnet
# (more expensive but smarter about edge cases).
ghost_model = "claude-haiku-4-5"

# Default timezone for new sessions.
default_timezone = "America/New_York"

# Hard cap on ghost Haiku ticks per session per day — defense
# against runaway loops. Independent of intensity.
max_ghost_ticks_per_day = 20

# Global concurrency cap: at most this many proactive_opportunity
# envelopes can fire across ALL sessions at the same instant. The
# fire path holds a semaphore; if it would exceed the cap, the cron
# row is re-scheduled with jitter (see fire-time deferral below).
# Keeps Anthropic-side cost spikes bounded and avoids saturating the
# main worker pool.
max_concurrent_fires = 3

# Anti-clustering jitter at ghost schedule time. When the ghost picks
# a fireAtMs, it adds a random offset uniformly drawn from this
# window. Prevents many sessions from converging on the same
# "obvious" time (e.g. everyone fires at Fri 4pm).
schedule_jitter_min_minutes = 0
schedule_jitter_max_minutes = 35

# Deferral when the concurrency cap is hit at fire time. Cron row is
# re-scheduled by a random offset in this window and tried again.
fire_defer_min_minutes = 5
fire_defer_max_minutes = 15

# Per-session-pair clustering guard. The fire path will not fire any
# two sessions' proactive envelopes within this many seconds of each
# other. Forces a global stagger even when the cap isn't full.
min_seconds_between_fires = 90
```

### Intensity → effective parameters

The `intensity` knob is the only thing most operators should touch.
It maps to a table that the budget module reads:

| Intensity | Cooldown (h) | Weekly cap | Sweep (min) | Ghost eagerness |
|-----------|--------------|------------|--------------|-----------------|
| 1 (blue moon) | 168 (7d) | 1 | 240–480 | "extremely rare; raise the bar dramatically" |
| 2 | 96 (4d) | 1 | 180–360 | "very picky" |
| 3 | 72 (3d) | 2 | 150–300 | "picky" |
| 4 | 48 (2d) | 2 | 120–270 | "slightly cautious" |
| 5 (balanced) | 24 | 3 | 90–240 | (default prompt language) |
| 6 | 18 | 4 | 75–210 | "moderately eager" |
| 7 | 12 | 5 | 60–180 | "lean toward acting when there's a real hook" |
| 8 | 8 | 7 | 45–150 | "act when in doubt; user wants frequent presence" |
| 9 | 6 | 10 | 30–120 | "high presence; daily-ish is fine if signals support it" |
| 10 (frequent) | 4 | 14 | 20–90 | "every active user likely gets something most weeks; only skip if zero signal" |

These are starting points — tune the table once we see real telemetry
from `decisions.jsonl`. Engagement decay still applies on top of every
intensity level (a level-10 chat with ignored attempts still doubles
its cooldown).

The ghost prompt's "eagerness" line gets substituted in at prompt-
build time, so the ghost actually behaves differently at different
intensities, not just probability-wise.

---

## CLI

A new top-level operator command for inspecting sessions and driving
brown-nose state from the terminal. Lives at `scripts/edmund-cli.ts`
with a `bin/edmund` wrapper that gets `chmod +x`'d and added to PATH
(or invoked as `bun run scripts/edmund-cli.ts` if PATH isn't wired).

### Commands

```
edmund sessions list
```
Lists every session in `state.db` (DMs + groups) with:
- session_key
- kind (dm / group)
- display name / chat name / handle
- last_inbound / last_outbound (relative: "12m ago", "3d ago")
- brown_nose: enabled? / disabled (reason) / never enrolled
- next eligible fire window (intensity-resolved cooldown applied)

Output is tab-aligned text. `--json` flag returns structured JSON for
piping into `jq`.

```
edmund session <session_id> brownnose --enable
edmund session <session_id> brownnose --disable [--reason "..."]
```
Toggle brown-nose for one session. Writes directly to the
`brown_nose_prefs` table. `--disable` records an optional reason
(defaults to "operator CLI"); the persona reads this so it knows the
context if main later wonders why.

```
edmund session <session_id> brownnose --invoke
```
Forces a ghost tick **now** for the given session, regardless of the
sweep schedule. Useful for testing prompt changes without waiting for
the natural cadence. Concretely:
1. Loads the session's prefs + history
2. Bypasses the active-hours window (operator override)
3. Still honors cooldown + weekly cap unless `--force` is also passed
4. Runs `ghost/think.ts` once
5. Prints the resulting decision to stdout (act/no, brief if any,
   fireAtMs if any)
6. Enqueues the cron row normally if `act: true` — so the fire
   path runs at the scheduled time on its own

```
edmund session <session_id> brownnose --invoke --fire-now
```
Like `--invoke`, but if the ghost decides `act: true`, the cron is
scheduled at `now()` (no jitter, no waiting) so the main model fires
immediately. Pure testing affordance — never wired into normal flow.

```
edmund session <session_id> brownnose --show
```
Prints current state for one session: prefs, recent decisions
(last 10 from `decisions.jsonl`), upcoming queued fires, intensity
resolution, budget state.

```
edmund session <session_id> brownnose --reset
```
Clears `brown_nose_prefs` for the session back to defaults. Cancels
any queued fires for it.

### Examples

```
$ edmund sessions list
SESSION_KEY                          KIND   NAME              LAST IN  LAST OUT  BROWN_NOSE
imessage:dm:+15550100001             dm     Jordan Carter    8m ago   8m ago    on (intensity 3)
imessage:dm:+15550100002             dm     Riley             2h ago   2h ago    on (intensity 3)
imessage:dm:+15550100005             dm     Avery Carter     1d ago   1d ago    on (intensity 3)
imessage:group:any-3cb4a8...         group  Weekend Squad     30m ago  -         off
...

$ edmund session imessage:dm:+15550100001 brownnose --disable --reason "testing"
disabled brown_nose for imessage:dm:+15550100001
reason recorded: testing

$ edmund session imessage:dm:+15550100002 brownnose --invoke
ghost ticking imessage:dm:+15550100002 ...
budget: cooldown ok (last fire 4d ago); 1/3 weekly cap used
ghost decision: act=true
  fireAtMs: 2026-05-15T18:42:00-04:00 (3h from now, jitter +18m)
  brief: "Friday afternoon — Riley mentioned weekend plans..."
  tags: [weekend, plans, weather]
  expiresAtMs: 2026-05-15T22:00:00-04:00
enqueued cron job_xxxxx
```

### Implementation

- `scripts/edmund-cli.ts` — top-level command dispatcher. Reads
  `state.db`, talks to `src/ghost/prefs.ts` and (for `--invoke`)
  `src/ghost/think.ts` directly. No daemon involvement needed for
  list/enable/disable/show — these are pure DB reads/writes.
- For `--invoke`, the CLI process runs a one-shot ghost tick in-
  process. It enqueues the cron row into the same store the daemon
  watches; the daemon picks it up via its normal scheduler loop.
  No IPC needed.
- `bin/edmund` — shell wrapper:
  ```sh
  #!/usr/bin/env bash
  cd "$(dirname "$0")/.."
  exec bun run scripts/edmund-cli.ts "$@"
  ```
- `package.json` gets `"edmund": "bun run scripts/edmund-cli.ts"` so
  `bun run edmund sessions list` also works.

### Subcommand-routing notes

- The CLI uses positional dispatch: first arg is the noun
  (`sessions` / `session`), second is either a subcommand
  (`list`) or an id, then a verb (`brownnose`), then flags.
- Unknown subcommands print usage and exit 1.
- All write commands print a one-line confirmation; `--quiet`
  suppresses for scripting.

## Testing rollout

For the testing phase, brown-nose is enabled against **every currently
known DM session** rather than starting with a single test user. This
gives realistic distribution of conversation textures and lets us see
how the system behaves at scale (and how the concurrency + stagger
guards perform under real load).

Mechanics:

1. **Auto-enrollment migration** — on first boot after Phase 1 ships,
   the prefs table is populated for every existing DM session in
   `sessions` that doesn't already have a row, with:
   - `enabled = config.brown_nose.dms_enabled_by_default` (true)
   - `active_hours = default (M-F 9-19 ET)`
   - `timezone = config.brown_nose.default_timezone`
   - `weekly_cap` and `cooldown_multiplier` from intensity table
   - `focus_suggestions = []`
2. **Group sessions are NOT auto-enrolled** even during testing —
   group misfires are too visible. A row is still created, but with
   `enabled = false`.
3. **Testing intensity** — start at `intensity = 3` for the first
   week (picky, low frequency). Raise gradually based on
   `decisions.jsonl` review and any push-back. Production default
   target is **5**.
4. **Concurrency cap during testing**: `max_concurrent_fires = 3`
   regardless of how many sessions are enrolled. The deferral
   logic ensures fires get rescheduled, not dropped — every
   eligible decision still eventually fires (or expires).
5. **Per-user opt-out remains immediate** — if a user pushes back,
   their session's `enabled` flips to false and stays that way until
   they say otherwise.

### Why concurrency caps matter at scale

If we have, say, 8 enrolled DMs and the intensity is balanced
(level 5), the ghost will schedule on the order of 3-8 fires per week
across all sessions. Without anti-clustering jitter, multiple ghosts
might converge on the same "obvious" times (Friday 4pm, Monday 9am).
The combination of:
- **schedule-time jitter** (0-35 min spread at ghost decision time)
- **fire-time deferral** (5-15 min push when cap is hit)
- **min spacing** (90 sec floor between any two fires)

…produces a smoothed firing pattern even when many sessions decide to
act in the same window. Worst case scaling: with 10 sessions all
firing in the same hour, the cap holds 3 concurrent and the deferral
walks the rest forward across a ~50-min window.

## Implementation order

Sequential phases. Each phase ships independently — daemon stays
working at every step.

### Phase 1: foundations (no model invocations)
1. `src/config/config.ts` — `brown_nose` block + defaults
   (including `intensity`, concurrency, stagger fields)
2. `state.db` migration: `brown_nose_prefs` table
3. `src/ghost/prefs.ts` — read/write per-session prefs; **auto-enroll
   migration** for existing sessions on boot
4. `src/ghost/intensity.ts` — pure mapping `intensity → {cooldownH,
   weeklyCap, sweepMin, sweepMax, eagernessClause}`
5. `src/ghost/budget.ts` — pure-function budget checks (active hours,
   cooldown, weekly cap, engagement decay, focus-suggestion overuse)
   using intensity-resolved params
6. `tests/ghost-budget.test.ts` — pure unit tests for the budget logic
   AND intensity-table mapping
7. `tests/ghost-prefs.test.ts` — round-trip prefs + auto-enroll
8. `scripts/edmund-cli.ts` + `bin/edmund` — initial commands:
   `edmund sessions list`, `edmund session <id> brownnose
   --enable|--disable|--show|--reset`. (`--invoke` lands in Phase 2
   once `ghost/think.ts` exists.)
9. `package.json` — add `"edmund"` script alias

**Ship gate**: `bun test` green. Operator can `edmund sessions list`
and toggle prefs. No model invocations yet.

### Phase 2: ghost thinking (no main invocations)
7. `persona/GHOST.md` — ghost system prompt
8. `src/ghost/think.ts` — build prompt, call Haiku, parse decision,
   write to `brownnose/decisions.jsonl`. Returns the decision; doesn't
   enqueue yet.
9. `src/ghost/observer.ts` — minimal: just the periodic sweep, no
   event subscriptions yet. For each enabled session, tick every
   90-240 min, log decisions.
10. `tests/ghost-think.test.ts` — gated like worker-smoke (env flag),
    runs a real Haiku call against a fixture envelope.
11. CLI: add `edmund session <id> brownnose --invoke [--fire-now]`
    now that `ghost/think.ts` exists. Lets operators test prompt
    changes against any session on demand.
12. **Operator can now read** `brownnose/decisions.jsonl` to see what
    the ghost would have done. **No actions fire yet.**

**Ship gate**: ghost decisions logging for ≥24h, manually reviewable.

### Phase 3: fire path
12. `src/ghost/queue.ts` — enqueue ghost decisions into cron store as
    `kind="brown_nose"` rows, with schedule jitter applied
13. `src/proactive/semaphore.ts` — in-memory concurrency guard with
    Promise-based queue; tracks last-fire-completed timestamp for
    the stagger check
14. `src/proactive/fire.ts` — cron-fire handler. Order: re-check
    budget → acquire semaphore (defer cron row if cap full) →
    stagger check (defer if last fire was too recent) → build
    envelope → invoke main → release semaphore + update last-fire
15. `src/channels/envelope.ts` — `kind` + `proactiveBrief` + render
    block when `kind === "proactive_opportunity"`
16. Wire the new cron kind into the scheduler dispatch
17. `tests/proactive-fire.test.ts` — concurrency cap honored under
    synthetic load (10 simultaneous fires → exactly 3 run concurrently,
    7 defer); stagger spacing honored
18. **End-to-end smoke**: one manual test where ghost fires and main
    runs against a synthetic brief

**Ship gate**: smoke test passes; concurrency tests green. Defaults
still off for groups; DMs on across all enrolled sessions.

### Phase 4: event triggers
17. Hook `observer.ts` into:
    - `onMainReplied` (post-sendDeliver)
    - `onSessionQuiet` (4h / 24h timers via cron rows)
    - `onActiveWindowStart` (daily cron)
18. **Ship gate**: ghost ticks reactively, not just on slow sweep.

### Phase 5: tools + persona
19. `src/mcp/tools/brown-nose.ts` — all 7 tools
20. `persona/VENUE_DM.md` + `VENUE_GROUP.md` — proactive_opportunity
    section
21. `persona/AGENTS.md` — push-back rule
22. **Ship gate**: main can disable/re-enable, set focus, query ghost.

### Phase 6: hardening
23. Engagement decay test (simulate 3 ignored attempts → cooldown
    doubles)
24. Focus-suggestion overuse test (3+ uses of same topic → ghost is
    told to back off it)
25. Time-zone edge cases (DST transitions, cross-TZ sessions)
26. Operator dashboard: a `/brownnose-status` skill or admin view
    that surfaces ghost state across all sessions (optional)

---

## Open questions resolved

| Q | A |
|---|---|
| Groups default? | **OFF**, opt-in per group |
| Annoyance recovery? | **Never auto-re-enable**; user must explicitly say so |
| Focus suggestions? | Used, but with per-topic-per-week cap (3 uses); over-use → back off the topic |
| Where ghost works? | `sandbox/<id>/brownnose/` — main has read access |
| Main aware? | Yes — receives `kind: proactive_opportunity` envelopes; has tools to control ghost; persona explains the system |
| Main controls schedule? | No — ghost owns scheduling. Main can only enable/disable, add focus suggestions, query state. |
| Test rollout? | **All currently-known DM sessions auto-enrolled** on first boot. Groups not auto-enrolled. Start intensity = 3, raise after telemetry review. |
| How many can fire at once? | **At most 3 concurrent** across all sessions globally (config `max_concurrent_fires`). Cron rows defer with 5-15 min jitter when cap is hit. |
| How is clustering prevented? | Three guards: schedule-time jitter (0-35 min), fire-time deferral when cap is full, min-spacing floor of 90 sec between any two fires. |
| Frequency tuning? | One `intensity` knob (1-10) that maps to cooldown, weekly cap, sweep cadence, and ghost eagerness language. See intensity table. |

---

## Risks & mitigations

1. **Runaway ghost spend.** Cap: `max_ghost_ticks_per_day = 20` per
   session. Budget check is pre-flight (before Haiku call), so most
   ticks resolve with zero LLM spend.
2. **Mis-fire in a group.** Groups default off. Fire path also rechecks
   `prefs.enabled` before invoking main.
3. **Push-back in a group is more expensive than a DM** (other people
   see it). Persona is taught: if a group brown-nose gets even mild
   negative signal, `disable_brown_nose` immediately — higher bar than
   DMs.
4. **Focus-suggestion becomes a new annoyance vector.** Per-topic per-week
   usage cap; over-use logs to feedback memory.
5. **State.db lock contention from ghost ticks.** Prefs are read once
   per tick; decisions write to JSONL (file, not DB). Cron writes are
   single-row inserts. No new lock pressure expected.

---

## What this changes about Edmund

After this ships, Edmund is no longer a pure-reactive chatbot. He is
two-tier: an always-watching cheap observer that decides moments, and
the same warm Edmund the user already knows reacting to those moments
with the same toolset and persona.

The hard part isn't the code — it's getting the ghost prompt right so
acts are rare, well-timed, and welcome. That part is iterative; the
`decisions.jsonl` log makes it tunable.
