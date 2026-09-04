# Capability expansion plan

> Historical design record. Written before or while the subsystem was built and kept because it explains why the shipped design looks the way it does. Where it disagrees with the code, the code is right.

Six features that broaden what Edmund can *do* (vs. user-scoped polish).
Built in this order — earlier items are substrate for later ones.

Codebase grounding (verified before writing this plan):

- Skills live at `skills/<name>/SKILL.md`, loaded progressively via
  `list_skills` / `read_skill` MCP tools. There is no install step today
  and no sandbox boundary beyond the existing `sandbox/` dir.
- Recall today is pure SQLite substring scan in `src/imessage/history.ts`
  (`search_history`, `thread_context`, `catch_me_up`). No embeddings.
- Web access is `src/web/fetch.ts` + a search tool with SSRF guards.
- `skills/instant-share/` already does Cloudflare Quick Tunnels for
  artifact delivery — the proven pattern we reuse for forms/sites.
- Sub-agents exist via `src/agents/spawn.ts`.
- Cron primitives live in `src/cron/`; MCP tool surface lives in
  `src/mcp/tools/` and is wired in `src/mcp/server.ts`.

Build order (each row builds on the row above):

1. Skill marketplace — substrate for everything that ships as a skill
2. Semantic recall — fixes the loudest current failure mode
3. Deep research — first new skill that exercises sub-agents
4. Ephemeral forms/sites — second skill, exercises hosting story
5. Live events / sports / odds — third skill, exercises live data
6. 2026 grafts — invisible quality lift across all of the above

---

## 1. Skill marketplace (self-extending skills)

**Pitch.** Edmund browses a curated registry of Claude skills, installs
them into `skills/<name>/`, and hot-uses them via the existing loader.

**Why high-impact.** This is the only feature that *compounds* — every
install permanently expands Edmund. The 2026 ecosystem (anthropics/skills,
SkillsMP, claudemarketplaces, 4,200+ skills) is real and stable.
Features 3-5 of this plan ship *as skills*, which means #1 is also the
fastest delivery vehicle for them.

**Architecture.**

- New `src/skills/registry.ts` — fetches/parses `marketplace.json` from
  an allowlist of GitHub orgs (default: `anthropics`, your own org).
- New `src/mcp/tools/skill-registry.ts` exposing:
  - `search_marketplace(query, source?)` → list of `{name, source, description, version}`
  - `install_skill(name, source)` → writes `skills/<name>/`, refuses if name exists
  - `uninstall_skill(name)` → moves to `skills/.trash/<name>.<ts>/`
  - `list_installed_skills()` → reads `data/installed-skills.json`
- Hot-reload: the existing `list_skills` reads the dir each call, so no
  loader changes needed.
- Persistence: `data/installed-skills.json` records `{name, source, sha, installed_at, first_used_at}`.

**Safety (non-negotiable).**

- Allowlist of source orgs in `config.toml` → `[skills.marketplace] allowed_sources = ["anthropics", "edmund-harness"]`.
- Never auto-run scripts on install. First invocation of any installed
  skill that contains executable content (`scripts/`, shebangs) requires
  an explicit Jordan confirmation via iMessage approval.
- Reject installs containing: binaries, `chmod +x` patterns, `curl | sh`,
  `eval` of network responses, anything outside the skill dir.
- Pin to a content-hash on install; refuse upgrade silently if hash
  drifts (require re-confirm).
- Operator kill-switch: `edmund skills disable <name>`.

**Difficulty.** M. Maybe 1 day with safety checks.

**Open questions.**

- Where do *we* publish our own skills (brown-nose, instant-share)?
  Recommend a new public repo `edmund-skills` with `marketplace.json`.
- Versioning: track a `version` field per skill or just sha?

---

## 2. Semantic recall

**Pitch.** Embedding-backed search over iMessage history + person memory
files + sandbox artifacts. Edmund actually answers "what did X say about
Y last month" even when the words don't match.

**Why high-impact.** Fixes a *current failure*, not a new surface.
Edmund's persona is "knows you"; substring search is the visible seam.
Indexed artifacts also make #3's research outputs queryable later.

**Architecture.**

- New `src/memory/embeddings.ts` — wrapper around `sqlite-vec` (zero
  infra, ships as a sqlite extension) keyed by message rowid.
- Local embedding model: gte-small via Transformers.js OR Ollama
  endpoint configurable in `config.toml`. **Default to local** so
  iMessage content never leaves the box.
- Background indexer:
  - On boot: backfill any unindexed messages since the last watermark.
  - On each inbound/outbound: incremental index (debounced, batch).
  - Nightly cron skill: re-index `persona/people/*` + `sandbox/**`.
- New MCP tool `semantic_search(query, since?, sender?, scope?)`:
  - `scope` ∈ `"this-chat" | "global" | "person:<handle>" | "artifacts"`
  - Returns `{rowid, chat, speaker, ts, text, score}`.
  - **Default scope is current chat**; cross-chat requires explicit scope
    arg (enforced cross-boundary rule).
- Keep `search_history` as-is; semantic is additive.

**Safety.**

- Per-person opt-out: a flag in their persona file disables their
  messages from being indexed.
- Embeddings stay local by default. If operator opts into a hosted
  embed provider, surface that clearly.
- Index file at `data/embeddings.sqlite` is gitignored.

**Difficulty.** M. The wiring is small; the careful part is the scope
boundary and the background indexer not stalling main reply path.

**Open questions.**

- Local embed model speed on Mac mini — benchmark gte-small vs.
  Ollama `nomic-embed-text` before committing.
- Index size estimate: ~768 floats × 4 bytes × N msgs. At 500k msgs,
  ~1.5GB. Acceptable.

---

## 3. Deep research (as a skill)

**Pitch.** A research skill: query → plan → parallel sub-agents fetch
→ reduce → iMessage-fied summary + full brief shared via instant-share.

**Why high-impact.** WebFetch+WebSearch today is one-shot. Multi-agent
research is the standout 2026 pattern and is *demoable* — "tell me
everything about X" produces something better than a single-pass answer.
Ships as the first non-trivial third-party skill (dogfoods #1).

**Architecture.**

- New `skills/deep-research/SKILL.md` documenting the pattern.
- New MCP tool `deep_research(question, depth?: "quick"|"standard"|"thorough")`:
  - Plan step: Sonnet drafts 3-7 sub-queries.
  - Fan-out: spawn N sub-agents via `src/agents/spawn.ts`, each gets a
    sub-query + a budget (token cap, max URLs).
  - Reduce: Sonnet synthesizes into a markdown brief.
  - "iMessage-fy" pass: 3-bullet summary + link to full brief shared
    via instant-share.
- Cap fan-out: `quick=2`, `standard=4`, `thorough=6`.
- Dedupe URLs across sub-agents.
- Pair with the existing RFP MCP for federal/contracts queries.

**Safety.**

- Token budget per sub-agent enforced at the runner level.
- Never follow URLs into private networks (SSRF guard already exists).
- Long-running — fire status updates back to chat ("researching… 3/5 done").

**Difficulty.** M. Most primitives exist.

---

## 4. Ephemeral forms / sites

**Pitch.** Edmund mints a short URL for a poll / RSVP / signup form
that auto-expires.

**Why high-impact.** Common iMessage use case ("ask everyone if
Saturday works"). instant-share already proves the UX.

**Architecture.**

- New `skills/ephemeral-forms/SKILL.md`.
- New MCP tool `create_form({title, fields, expires_in_hours, max_responses?})`
  returns `{public_url, admin_url, expires_at}`.
- Two delivery paths:
  - **Lean (ship first):** Cloudflare Worker template + KV namespace
    with `expirationTtl` on submissions. Deploy via wrangler from a
    template dir; route is `/<random-slug>`. Worker is shared and
    multi-tenant; slug + secret guard each form.
  - **Heavy (later):** One Worker per form, torn down by cron at
    expiry. Cleaner blast radius but more wrangler operations.
- Admin URL streams new submissions back to the originating iMessage
  chat via a webhook into the harness.

**Safety.**

- Turnstile on the public form (free).
- Rate-limit per IP at the Worker.
- Cap `max_responses` (default 100).
- Banner on every form: "responses visible to <creator name>, hosted
  ephemerally, auto-deletes <date>".
- Never collect PII without an explicit consent checkbox.
- Form templates are static — no arbitrary JS.

**Difficulty.** S–M. Lean version reuses Quick Tunnel pattern.

---

## 5. Live events / sports / odds

**Pitch.** Real-time scores + lines, optional "ping me when the game
is close" cron.

**Why high-impact.** Concrete, demoable, sticky for sports-watching
contacts. Narrow audience but very used when used.

**Architecture.**

- New `skills/live-sports/SKILL.md`.
- New `src/mcp/tools/sports.ts`:
  - `live_scores(league, team?)` — wraps ESPN scoreboard endpoints.
  - `upcoming_games(league, days)` — schedule.
  - `odds(league, team?, market?)` — wraps the-odds-api (500 req/mo
    free tier).
- Cache 30s in-memory.
- Cron skill: `watch_game(game_id, alert_when: "within_5" | "final" | "Q4_start")`
  uses existing cron to schedule polling, fires brown-nose-style
  alerts when condition trips.

**Safety.**

- **Never proactively suggest bets.** Odds are information, not advice.
  Add a persona rule in `persona/AGENTS.md`.
- Respect bookmaker geographic restrictions in returned data.
- API keys in `config.toml` only; nothing checked in.

**Difficulty.** S.

---

## 6. 2026 grafts (cross-cutting)

Three small improvements that lift everything above:

**6a. Typed sub-agent roles.** Restrict `Agent(subagent_type=...)` to a
fixed set: `researcher`, `summarizer`, `coder`, `reviewer`. Each gets
its own system prompt + tool allowlist. Plug into #3.

**6b. Prompt caching on persona.** The big system prompt (persona +
AGENTS.md + venue + person file) is largely stable per chat. Mark it
cacheable. Free latency + cost win across every reply.

**6c. Opus/Haiku routing.** Opus for plan/decide; Haiku for tool-result
digestion and the ghost observer (already Haiku). Add a router helper
that picks the model per task type instead of per code path.

**Difficulty.** S each. Ship alongside whichever feature surfaces them.

---

## Build sequence summary

| # | Feature                | Difficulty | Why this slot |
|---|------------------------|------------|---------------|
| 1 | Skill marketplace      | M          | Substrate for 3, 4, 5 |
| 2 | Semantic recall        | M          | Fixes loudest current seam, independent |
| 3 | Deep research          | M          | First marketplace skill, exercises sub-agents |
| 4 | Ephemeral forms        | S–M        | Second skill, exercises hosting story |
| 5 | Live sports / odds     | S          | Third skill, exercises live data + cron alerts |
| 6 | 2026 grafts            | S × 3      | Roll in opportunistically alongside 3-5 |

## Cross-cutting concerns to track

- **Allowlists everywhere** — skill sources, embed providers, sport
  APIs, Worker domains. Centralize in `config.toml` under each feature.
- **Operator dashboard** — every feature gets a panel: installed
  skills, index health, recent research jobs, active forms, watched
  games.
- **Persona teaching** — update `persona/AGENTS.md` once per feature
  with the rule of thumb for when to use each new tool.
- **Tests** — pure functions (registry parser, scope guard, form
  template renderer) get unit tests; integration tests live behind a
  flag because they hit network.
