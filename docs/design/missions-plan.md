# Missions: autonomous task force for bold long-running goals

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

## Pitch

User: "Edmund, try to start an online business, only ping me on the first sale."
Edmund: spins up a *mission* — a multi-day, multi-tick, multi-role autonomous
effort with a durable journal, milestones, hard budget, and a public share
link. Ticks the mission on a cron. Only relays to the user when a milestone
declares it. Halts on budget or on user kill.

This doc is the plan. Build order is strict — earlier sections are substrate
for later ones.

## Codebase grounding (verified)

- `src/agents/spawn.ts` spawns detached `claude -p` workers; result lands in a
  per-agent sandbox file. `src/agents/store.ts` is SQLite (`agents.db`, WAL).
- `src/cron/` already fires scheduled `systemEvent` payloads back into a
  parent session (this is the wake-up path for finished agents today).
- `dashboard/` is a Bun + Hono + React + SQLite LAN-only PIN-gated UI reading
  the harness's existing stores. Routes live in `dashboard/server/routes/`.
- `skills/cloudflare/` + `skills/instant-share/` already use Cloudflare Quick
  Tunnels for ephemeral public delivery — proven exposure path.
- `skills/teams/` documents the shared-scratch coordination idiom we extend.
- Config schema is `src/config/config.ts`; persona/sandbox roots are
  configurable there.

What we are NOT changing: the spawn-detached-`claude -p` worker model, the
cron wake-up envelope shape, the existing `agents` table (missions get their
own DB), or the LAN dashboard.

## Design pillars (from research)

These are non-negotiable; every other choice serves them.

1. **Fresh `claude -p` per tick.** Long-lived agents context-rot. The mission
   *state* is durable; the *agent* is ephemeral. (Manus, Anthropic, Cognition
   all converged here in 2026.)
2. **SQLite ledger is the single source of truth.** Charter, todos, journal,
   milestones, events. No agent-to-agent direct messaging. No state in
   process memory.
3. **Orchestrator + ledger beat free-form.** A Planner role mutates the
   todo graph; Workers pull. Workers cannot edit the plan.
   (Magentic-One pattern.)
4. **Doer/Critic split.** When a Worker claims a milestone, a fresh Critic
   tick reads the artifact + acceptance criteria with no Worker context and
   returns `accept | reject(reason)`. Stateless. This is the single biggest
   empirical lever — most of Anthropic's +90% lift was here.
5. **Serial ticks, not concurrent roles.** Missions are write-heavy. Cognition's
   law: conflicting decisions = bad results. One tick at a time per mission.
6. **Hard rails are enforced, not advised.** Per-mission token + dollar caps
   decrement at every spawn; on overshoot the cron handler refuses to fire.
   Alerts ≠ enforcement (the $47K-loop postmortem).
7. **Stuck detection is structural.** Fingerprint repeated tool calls; flip
   to `blocked` after N. Mission posts a question via Edmund to the user
   instead of grinding.
8. **Recitation at the tail.** Every tick prompt ends with the current
   charter + open todos so the objective lives in the recency-bias zone.

## Architecture overview

```
                      ┌─────────────────────────────────┐
                      │  iMessage user                  │
                      └────────────┬────────────────────┘
                                   │
                       start_mission / kill_mission / mission_status
                                   ▼
                      ┌─────────────────────────────────┐
                      │  Edmund (main session)          │
                      │  MCP tools in src/mcp/tools/    │
                      └────────────┬────────────────────┘
                                   │  inserts mission row + first cron tick
                                   ▼
              ┌──────────────────────────────────────────────────┐
              │  data/missions.db  (single source of truth)      │
              │  missions / todos / journal / milestones /       │
              │  events / fingerprints / budget_ledger           │
              └──────────────┬───────────────────────────────────┘
                             │ read at start of every tick / write at end
                             ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Mission tick (fired by cron via systemEvent prefix)    │
        │  src/missions/tick.ts                                   │
        │   1. select next role (Planner | Worker | Critic |      │
        │      Reporter) per state machine                        │
        │   2. budget + stuck checks                              │
        │   3. spawn fresh `claude -p` w/ role prompt + ledger    │
        │   4. parse structured output (JSON-after-text)          │
        │   5. apply mutations to missions.db                     │
        │   6. emit events for the share page                     │
        │   7. schedule next tick (adaptive interval)             │
        └──────────────┬─────────────────────────────┬────────────┘
                       │                             │
                       ▼                             ▼
        ┌─────────────────────────┐    ┌───────────────────────────┐
        │  Cloudflare Tunnel      │    │  iMessage relay           │
        │  m.edmund.<tld>/<slug>  │    │  fires only on milestone  │
        │  SSE feed from          │    │  or `blocked` escalation  │
        │  events table           │    └───────────────────────────┘
        └─────────────────────────┘
```

## Schema (`data/missions.db`)

```sql
CREATE TABLE missions (
  id              TEXT PRIMARY KEY,        -- "mis_<ts>_<rand>"
  slug            TEXT UNIQUE NOT NULL,    -- 22-char base62 for share URL
  parent_session_key TEXT NOT NULL,        -- who started it (for relays)
  goal            TEXT NOT NULL,
  success_condition TEXT NOT NULL,         -- prose; Critic uses this verbatim
  report_policy   TEXT NOT NULL,           -- "milestone_only" | "all" | "blocked_only"
  status          TEXT NOT NULL,           -- planning|running|blocked|paused|done|failed|halted
  created_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  -- budgets (hard rails)
  token_cap       INTEGER NOT NULL,        -- input+output combined
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  dollar_cap_cents INTEGER NOT NULL,
  dollars_used_cents INTEGER NOT NULL DEFAULT 0,
  tick_cap        INTEGER NOT NULL,        -- max ticks ever
  ticks_used      INTEGER NOT NULL DEFAULT 0,
  -- cadence
  next_tick_at    INTEGER,
  tick_interval_ms INTEGER NOT NULL DEFAULT 300000,  -- adaptive
  -- share page
  share_password  TEXT,                    -- optional, null = public-with-slug
  -- privacy
  redaction_set   TEXT NOT NULL DEFAULT '[]'  -- JSON array of strings to filter on read
);

CREATE TABLE todos (
  id              TEXT PRIMARY KEY,        -- "tod_<...>"
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  parent_id       TEXT REFERENCES todos(id),
  title           TEXT NOT NULL,
  acceptance      TEXT NOT NULL,           -- crisp definition-of-done, set at creation
  status          TEXT NOT NULL,           -- todo|in_progress|done|blocked|rejected
  blocked_by      TEXT,                    -- comma-sep todo ids
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_progress_at INTEGER,
  artifact_path   TEXT,                    -- path inside mission sandbox
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER
);
CREATE INDEX todos_mission_status_idx ON todos(mission_id, status);

CREATE TABLE journal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  tick_id         TEXT NOT NULL,
  role            TEXT NOT NULL,           -- planner|worker|critic|reporter
  todo_id         TEXT,
  entry           TEXT NOT NULL,           -- prose: what I did, what I decided
  next_action     TEXT,                    -- prose hint for the next tick
  created_at      INTEGER NOT NULL
);
CREATE INDEX journal_mission_id_idx ON journal(mission_id, id);

CREATE TABLE milestones (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,           -- what happened, evidence
  artifact_paths  TEXT NOT NULL DEFAULT '[]',
  proposed_by_tick TEXT NOT NULL,
  critic_verdict  TEXT,                    -- accept|reject — null while pending
  critic_reason   TEXT,
  relayed_at      INTEGER,                 -- when Edmund pinged the user
  created_at      INTEGER NOT NULL
);

-- Append-only event log; this is what the share page SSE replays/streams.
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic, used as Last-Event-ID
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  kind            TEXT NOT NULL,           -- tick_start|tick_end|todo_added|todo_done|
                                           -- milestone_proposed|milestone_accepted|
                                           -- milestone_rejected|blocked|budget_warn|
                                           -- budget_halt|relay|status_change|restart
  payload         TEXT NOT NULL,           -- JSON
  created_at      INTEGER NOT NULL
);
CREATE INDEX events_mission_idx ON events(mission_id, id);

-- Stuck detection. Hash (role, tool, args, output_preview) per tick.
CREATE TABLE fingerprints (
  mission_id      TEXT NOT NULL,
  fp              TEXT NOT NULL,
  count           INTEGER NOT NULL DEFAULT 1,
  last_seen_at    INTEGER NOT NULL,
  PRIMARY KEY (mission_id, fp)
);

CREATE TABLE budget_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id      TEXT NOT NULL,
  tick_id         TEXT,
  kind            TEXT NOT NULL,           -- tokens|dollars
  delta           INTEGER NOT NULL,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);
```

Sandbox: `sandbox/missions/<id>/` with `charter.md`, `artifacts/`, and per-tick
worker scratch dirs `ticks/<tick_id>/`.

## Module layout

```
src/missions/
  store.ts           -- SQLite wrapper, all reads/writes go through here
  types.ts
  charter.ts         -- read/write charter.md from goal+success_condition
  ledger.ts          -- ledger-snippet builder: todos, recent journal, milestones
  budget.ts          -- record + check token/dollar/tick caps
  fingerprint.ts     -- hash + stuck-detection
  redact.ts          -- write-time regex sweep + per-mission denylist
  prompts/
    planner.md
    worker.md
    critic.md
    reporter.md
  roles.ts           -- compose role prompt + ledger snippet + charter tail
  tick.ts            -- the heartbeat: pick role → spawn → parse → mutate → schedule
  spawn.ts           -- thin wrapper over agents/spawn.ts, mission-flavored env
  parse.ts           -- structured-output extraction (JSON block after prose)
  relay.ts           -- decide if a milestone/blocked event should ping the user
  events.ts          -- append-only event emitter (every mutation logs one)
```

MCP surface (`src/mcp/tools/missions.ts`):

- `start_mission({ goal, success_condition, token_cap?, dollar_cap_cents?, tick_cap?, report_policy? })` → `{ id, slug, share_url }`
- `list_missions({ status? })`
- `mission_status(id)` — short text summary built from ledger
- `mission_journal(id, n?)` — tail of journal
- `pause_mission(id)` / `resume_mission(id)` / `kill_mission(id)`
- `mission_answer(id, text)` — user replies to a `blocked` question; resumes the mission

## The tick loop

A tick is the unit of work. One tick = one fresh `claude -p` invocation in one
role. Triggered by `src/cron/` firing a `systemEvent` of the form
`[MISSION_TICK]<mission_id>`. The cron handler:

1. Load mission row. If `status` ∉ {running, planning} → drop tick.
2. Budget check (`budget.canTick(mission)`). If over → flip status to
   `halted`, emit `budget_halt`, relay to user, end.
3. Stuck check. If the last 3 ticks have produced identical fingerprints
   on the same todo → flip todo to `blocked`, escalate via `relay.ts`.
4. **Role selection** (deterministic state machine, not LLM-decided):
   - No todos and no `planning` journal yet → **Planner**.
   - A milestone is `proposed` with no verdict → **Critic** on that milestone.
   - A milestone was just `accepted` and report_policy says relay → **Reporter**.
   - Any `todo` is `in_progress` with stale `last_progress_at` → **Worker** (resume).
   - Any `todo.status = "todo"` with no unmet `blocked_by` → **Worker** (claim next).
   - Else → **Planner** (replan).
5. Build the role prompt: `prompts/<role>.md` + charter (head) + ledger
   snippet (recent journal tail, open todos, milestone state) recited at
   the **tail** of the prompt.
6. Spawn fresh `claude -p` via `spawn.ts`. System prompt is the role; user
   prompt is the ledger snippet. Output format: stream-json, same as
   `agents/spawn.ts` today.
7. Parse the worker's final assistant text. Each role's prompt mandates a
   single fenced ```json block at the end with a role-specific schema
   (todo mutations / artifact path / verdict / relay text). Prose above
   is free-form journal content.
8. Apply mutations via `store.ts` inside a single SQLite transaction.
   Every mutation appends to `events` so the share page sees deltas.
9. Record token/dollar usage from the runner's reported usage block.
10. Fingerprint the tick. Update `fingerprints` table.
11. Pick `next_tick_at`: 30s if a todo just advanced, 5min default,
    backoff to 30min on consecutive no-ops, suspend on `blocked`.
12. Schedule the next `[MISSION_TICK]` cron row.

`tick.ts` is the only mutator of mission state outside the MCP tools.

## Role prompts (shapes)

Stored as `src/missions/prompts/<role>.md`, loaded once and cached.

### Planner

Job: shape the todo graph. **Cannot edit artifacts. Cannot call tools beyond
read.** Output: a JSON patch over todos.

```
You are the PLANNER for mission <id>.

Goal: <goal>
Success condition: <success_condition>

Read the ledger below. Decide:
- What's the next concrete thing that moves us toward the success condition?
- Are any open todos now redundant / wrong / blocked?
- For every new todo, write a crisp acceptance criterion. A todo without a
  testable acceptance criterion is malpractice — the Worker has no way to
  know they're done and the Critic has no way to check.

Output:
1. One paragraph of journal — what you observed and why you chose this plan.
2. A fenced ```json block:
   { "add": [{title, acceptance, parent_id?, blocked_by?}, ...],
     "update": [{id, status?, blocked_by?}, ...],
     "next_action": "<one-line hint for the next tick>" }

You cannot mark a todo done. You cannot propose a milestone. You can only
shape the graph. Be ruthless about killing zombie todos.
```

### Worker

Job: execute exactly one todo. **Has full tool palette (Bash, Read, Write,
WebFetch, skills) inside `sandbox/missions/<id>/ticks/<tick_id>/`.**

```
You are a WORKER on mission <id>, executing this todo:

  Title: <todo.title>
  Acceptance: <todo.acceptance>
  Attempt: <todo.attempts + 1>

Read the ledger. Recent worker journal entries are at the bottom — if you
were the previous worker on this todo, resume; if not, treat them as context.

Rules:
- Do the work. Write artifacts under <sandbox>/artifacts/ with descriptive
  filenames; record relative paths in your output.
- If you cannot complete this todo, DO NOT mark it done. Mark it blocked
  with a specific reason. False completion is the worst possible outcome —
  the Critic will catch it and you will have wasted a tick.
- If the acceptance criterion is unclear, mark blocked with reason
  "acceptance unclear: <what>". Planner will refine.
- If your work plausibly satisfies a mission-level milestone, propose it.

Output:
1. Free prose: what you did, what you observed, what you'd do next.
2. ```json
   { "status": "done" | "blocked" | "in_progress",
     "blocked_reason": "<if blocked>",
     "artifacts": ["artifacts/foo.md", ...],
     "propose_milestone": { "title": "...", "body": "...", "artifact_paths": [...] } | null,
     "next_action": "<one-line hint>" }
```

### Critic

Job: verify a proposed milestone against the success condition and the
artifacts. **Fresh context, no worker chain.**

```
You are the CRITIC for mission <id>.

Mission goal: <goal>
Mission success condition: <success_condition>

A worker has proposed this milestone:
  Title: <m.title>
  Body: <m.body>
  Artifacts: <m.artifact_paths> (read them)

Your job: decide accept|reject. Be skeptical. Common worker failure modes:
- Wrote a plan or a draft and called it shipped.
- Cited an outcome with no evidence in the artifacts.
- Met a proxy of the criterion instead of the criterion itself.
- Marked a "test passed" without the test actually existing.

Output:
1. Prose: what you checked, what you saw.
2. ```json
   { "verdict": "accept" | "reject",
     "reason": "<one paragraph; if accept, what evidence convinced you;
                if reject, what specifically is missing or wrong>" }

Never accept on vibes. If the artifacts don't show it, reject.
```

### Reporter

Job: write the iMessage relay text when policy says to ping the user.
Trivial role, exists to keep persona out of the doer/critic loop.

```
You are the REPORTER for mission <id>. An accepted milestone needs to be
relayed to the user via iMessage. Match Edmund's voice from SOUL.md.

Milestone: <title>
Body: <body>
Share URL: <share_url>

Output:
1. ```json
   { "text": "<iMessage-shaped reply, no markdown, ~1-3 short paragraphs>",
     "attach_share_url": true | false }
```

The relay handler in `relay.ts` forwards `text` to the parent session via
the existing channel-deliver path.

## Budget enforcement (hard rail)

`budget.ts`:

- `recordSpawn(mission, ticks=1)` — increments `ticks_used`.
- `recordUsage(mission, tokens, cents)` — increments `tokens_used`,
  `dollars_used_cents`; appends to `budget_ledger`.
- `canTick(mission)` — false if any cap exceeded.
- At 80% of any cap, emit `budget_warn` event and inject a "wind down — no
  new todos, finish open ones" line into the next Planner tick.
- At 100%, the cron handler refuses to fire; mission status → `halted`;
  Reporter ticks once with the budget summary; the share page goes static.

Dollars are computed from the runner's reported usage block using the
per-model rate card in config (`[missions.rates]`). This is the only place
in the harness today that needs $-cost accounting; it's deliberately
mission-scoped so it can't leak.

## Stuck detection

`fingerprint.ts` produces a stable string from each tick:

```
fp = sha1(role + ':' + active_todo_id + ':' +
          json(tool_calls.map(c => [c.name, normalize(c.args), c.output_preview_64])))
```

Update `fingerprints` row with `count += 1`. If `count >= 3` for the same
`(mission, fp)` → flip the active todo to `blocked` with reason
`"stuck: same fingerprint x3"` and emit `blocked` event. Relay policy then
fires a user ping if `report_policy ∈ {milestone_only, blocked_only}`.

The user can answer with `mission_answer(id, text)` — recorded as a journal
entry tagged `role=user`, todo unblocks, next tick proceeds.

## Share page (cross-references docs/missions-dashboard-plan.md)

In short: extend `dashboard/server/` with two new public routes,
unauthenticated except for the unguessable slug:

- `GET /m/:slug` — serves the React shell.
- `GET /m/:slug/events` — SSE, `Last-Event-ID` honored, replays from the
  `events` table.

Exposed publicly via Cloudflare Tunnel (`skills/cloudflare`) at
`m.<configured-domain>/m/<slug>`. Headers: `X-Robots-Tag: noindex,nofollow`,
`Referrer-Policy: no-referrer`, `/m/` denied in `robots.txt`.

Page layout v1:
- Header: goal, status pill, ticks_used / cap, $/tokens burn.
- Left: todo Kanban (todo / in_progress / blocked / done).
- Center: virtualized event timeline, sticky "Jump to latest."
- Right: milestones, with critic verdict badges and artifact links.

Mobile: collapse to single column, tab switcher (Timeline / Todos /
Milestones). The friends opening this from iMessage are on phones.

Redaction (`redact.ts`): write-time regex sweep on every event payload
before insert (`sk-...`, `xoxb-...`, JWTs, AWS keys, 32+ char high-entropy
strings). Plus per-mission denylist in `missions.redaction_set` — when
the agent reads any env or credential file, add the literal value to the
mission's denylist; the public `/m/:slug/events` route runs a final
substring filter before sending.

## Config additions (`src/config/config.ts`)

```toml
[missions]
enabled = false                    # opt-in
data_dir = "data"                  # missions.db lives here
sandbox_root = "sandbox/missions"  # per-mission scratch
default_token_cap = 5_000_000
default_dollar_cap_cents = 2000    # $20
default_tick_cap = 200
default_tick_interval_ms = 300_000 # 5 min
share_domain = ""                  # e.g. "m.edmund.example" (Cloudflare Tunnel host)
share_robots_disallow = true

[missions.rates]
# per-Mtok in cents; populated from current Claude rate card
sonnet_input_cached = 30
sonnet_input = 300
sonnet_output = 1500
```

All missions are off until `enabled = true`.

## MCP tool wiring

Add `src/mcp/tools/missions.ts` exporting the tools listed above; wire in
`src/mcp/server.ts` alongside `agents` / `cron`. Persona (`persona/SOUL.md`
or a new `persona/MISSIONS.md` section) gets a short paragraph teaching
Edmund when to reach for `start_mission`: only when the user explicitly
asks for autonomy or a long-horizon attempt, never for one-shot work,
always confirm the goal + success condition + budget back to the user
before calling `start_mission`.

## Build order

Each step is independently testable and shippable. Don't conflate.

1. **Schema + store + types.** `src/missions/store.ts` with all tables.
   `data/missions.db` materializes on first import. Unit-test CRUD.
2. **Charter + ledger snippet builder.** Pure functions over the schema;
   given a mission row + recent journal, build the prompt-tail text the
   role prompts will consume. Snapshot-test against fixtures.
3. **Budget + fingerprint primitives.** `budget.ts`, `fingerprint.ts`.
   Unit-tested in isolation, no LLM in the loop yet.
4. **Tick loop with a fake LLM.** `tick.ts` + `parse.ts` driven by a
   stub `spawn.ts` that returns canned role outputs from fixtures. Run
   end-to-end mission lifecycle in a test: planner → worker → milestone →
   critic accept → reporter → done. This is where the state machine gets
   shaken out without burning tokens.
5. **Real `claude -p` integration.** Wire `spawn.ts` to the existing
   `agents/spawn.ts` machinery. First live mission: trivial goal like
   "write three jokes about Postgres; success = three jokes in
   artifacts/jokes.md, each under 200 chars." End-to-end on real model.
6. **MCP tools + cron wiring.** Add `src/mcp/tools/missions.ts`, wire
   `[MISSION_TICK]` handler into `src/cron/fire.ts`. Edmund can now start
   missions from iMessage.
7. **Relay + escalation.** `relay.ts` + the `mission_answer` flow.
   `blocked` ticks ping the user; user reply unblocks.
8. **Share page server-side.** Two new routes in `dashboard/server/`,
   public, slug-only, SSE with `Last-Event-ID`.
9. **Share page UI.** Header + timeline first. Todos + milestones panes
   after. Mobile pass before sharing in iMessage.
10. **Cloudflare Tunnel publish.** Reuse `skills/instant-share` /
    `skills/cloudflare` patterns. Configure `[missions].share_domain`.
11. **Redaction.** Write-time regex + per-mission denylist hooks.
    Don't ship public exposure without this.

## What we are deliberately NOT building (v1)

- Concurrent worker parallelism on the same mission. Cognition's law;
  serial ticks only. Add later only with explicit per-todo claim locking.
- A dedicated LangGraph-style `interrupt()` checkpointer. The
  `blocked → mission_answer` flow covers this for now.
- External actuators (Stripe, Etsy, email-as-user, deploys). v1 missions
  can research, plan, write artifacts, run local code. Real-world side
  effects come behind a per-mission opt-in allowlist later.
- Cross-mission learning / shared memory. Each mission is its own island.
- A learned stall classifier. The fingerprint heuristic is the v1.
- A dedicated MCP server for the dashboard. The dashboard server already
  reads our SQLite stores directly; same here.

## Success criteria for v1

- Edmund can start a mission from iMessage in one turn after confirming
  the goal + success condition + budget.
- A mission with a falsifiable success condition runs to `done` end-to-end
  without intervention, including at least one Critic-rejected milestone
  that gets corrected.
- A mission that hits its budget halts cleanly and reports.
- A stuck mission escalates to the user via Edmund within 3 stalled ticks.
- The share URL works on a phone over LTE for an outside viewer, replays
  history on first load, and streams new events live.
- No secret material from env, credentials, or the agents' own tool
  outputs appears on the public share page (verified by a deliberate
  redaction-set test mission).
