---
name: teams
description: Coordinate multiple sub-agents as one unit — parallel investigation, multi-stage pipelines, or side-by-side comparisons. One `spawn_team` call replaces N `spawn_agent` calls, shares a scratch dir between members, and fires ONE wake-up event when everyone's done (not one per member).
---

# teams

A team is a named group of sub-agents spawned together. Each member runs the same detached-worker runtime as a solo `spawn_agent`, but with three things layered on top:

1. A shared `team_id` so you can query + cancel them as a unit.
2. A shared scratch directory (`<parent-sandbox>/teams/<team_id>/shared/`) that every member can read and write — this is how members hand off artifacts to each other.
3. A team-done wake-up event that fires once, when the last member settles. No per-member polling, no per-member wake-ups flooding the session.

Read `skills/agents/SKILL.md` first. Everything in "agents" about writing tasks, reading results, and the >30s mandate applies here too — teams are just a composition on top.

## When to reach for a team

**Yes, use a team:**
- **Parallel investigation** — multiple angles on one question, each with its own lens. "Research the security story, the perf story, and the DX story" → three roles, one wake-up.
- **Comparison** — the user named N options and wants them evaluated against the same criteria. One member per option. See `read_skill("teams/compare-options")`.
- **Research pipeline** — find sources → distill → sanity-check. Sequential by data dependency, concurrent on the wire. See `read_skill("teams/research-trio")`.
- **Cross-verification** — two members independently answer the same question; you surface both to spot disagreement.
- **Divide-and-conquer** — one big task split into self-contained chunks (e.g. "summarize this 50-page doc": one member per section, plus a synthesizer).

**No, solo `spawn_agent` is enough:**
- Single long task with no decomposition into roles.
- Fire-and-forget background work you'll relay raw.
- Anything under ~30s (just do it inline).

**No, inline is enough:**
- A single tool call (one web fetch, one history search).
- Quick factual lookups.

A team is strictly more overhead than a solo agent — N API calls, coordination via shared files, a synthesis step on your end. Don't reach for one unless the work genuinely splits.

## The four tools

### `spawn_team(members)`

One call starts all members. `members` is an array of `{role, task}` objects:

```
spawn_team(members: [
  { role: "scout",       task: "Search for… Write findings to {shared}/scout.json. Final text: one-line recap + path." },
  { role: "summarizer",  task: "Read {shared}/scout.json. Pick top 5. Write to {shared}/summary.md. Final text: the 5 takeaways." },
  { role: "verifier",    task: "Read {shared}/summary.md. Flag anything stale or over-claimed. Final text: solid vs needs-caveat vs drop." },
])
```

Returns `{team_id, sharedDir, agents: [{id, role}, ...]}`. The session lock releases immediately; your turn should end soon after.

### `list_team(team_id)`

Status across all members. Use when the user asks "is it done yet?" or you want to see who's still running before reading results.

```
team 20260420_abc:
  scout [done] 34s — Search for…
  summarizer [running] 12s — Read {shared}/scout.json…
  verifier [pending] 0s — Read {shared}/summary.md…
```

### `read_team_results(team_id)`

Returns every member's final text, keyed by role. Call this when the team-done wake-up fires. Works even if some members are still running (those are marked `(not yet complete)`) — but normally wait for the wake-up so you get the full picture.

Members run the same way solo agents do: their **final assistant text** is the result. They cannot message the user; you're the relay. Never paste raw — synthesize.

### `cancel_team(team_id)`

Kills every running member. Use when the collective work is obsolete ("never mind, I don't need that anymore"). Individual members you want to stop → `cancel_agent(id)`.

## The shared scratch directory

`<parent-sandbox>/teams/<team_id>/shared/` is the coordination substrate. Every member is told the path in their system prompt and is instructed to:

- **Read from shared at startup** — pick up whatever earlier roles dropped.
- **Write intermediate artifacts there** with role-prefixed filenames: `scout-sources.json`, `summarizer-picks.md`, `option-a-findings.md`.
- **Never poll** — do your work, drop your output, produce your final text, exit.

Members run concurrently. "Sequential" ordering is emergent from data dependencies, not the runtime — a downstream role blocks on a file until the upstream role has written it. If the upstream role fails, downstream roles may finish with partial or missing data; the verifier pattern in `research-trio` is one way to catch that.

### Writing handoffs into task strings

Since members coordinate only via the shared dir, every task string must spell out the contract:

- What files this role **reads** from shared (if any) + expected schema.
- What files this role **writes** to shared + filename + schema.
- What the role's **final text** should be (that's what you get back from `read_team_results`).

Bad: *"scout: find sources about X"*
Good: *"scout: search for authoritative info on X. Drop a JSON file at {shared}/scout-sources.json with 8-12 entries: `{url, title, one-line-summary, date, source-type}`. Prioritize primary sources. Your final text: one-sentence recap + path to the file."*

The shared-dir instructions are automatically injected into each member's system prompt by the runtime. You don't need to re-explain that the shared dir exists — just reference the filenames.

## The completion model

When a team's last member settles, ONE wake-up event fires in the parent session:

```
[Scheduled event · <timestamp>]
An agent team has finished (team_id: 20260420_abc, 3 members, all done).
Read results with `read_team_results("20260420_abc")` and relay to the user.
```

See the event, call `read_team_results`, synthesize, send. The user is waiting — don't just acknowledge.

If some members failed, the event still fires when the last one settles. `read_team_results` labels failed members inline (`[agent failed — output below may be partial]`); work with what you have.

## Common team patterns

### Parallel investigation (different angles)

```
spawn_team(members: [
  { role: "security",   task: "How is {thing} authenticated? Review threat model, known CVEs, compliance story. Final text: 5 bullets." },
  { role: "perf",       task: "What's the latency / throughput / resource profile of {thing}? Benchmarks if public. Final text: 5 bullets." },
  { role: "dx",         task: "Setup time for a new dev, API ergonomics, quality of docs on {thing}. Final text: 5 bullets." },
])
```

Each role is orthogonal — no shared-dir handoff needed. Synthesize into one reply: "Security: ____. Perf: ____. DX: ____. Verdict: ____."

### Pipeline (data-dependent stages)

See `read_skill("teams/research-trio")` for the canonical scout → summarize → verify pattern. The shape generalizes — any sequential pipeline works: *extract → classify → rank*, *fetch → parse → validate*, etc.

### Side-by-side comparison

See `read_skill("teams/compare-options")`. One member per named option, same criteria list in every task string, agents don't see each other. Output is apples-to-apples by construction.

### Cross-verification (redundancy)

```
spawn_team(members: [
  { role: "answer-a", task: "Answer: {question}. Cite sources. Final text: answer + 3 sources." },
  { role: "answer-b", task: "Answer: {question}. Cite sources. Final text: answer + 3 sources." },
])
```

If they agree, you have double-verified. If they disagree, say so to the user and let them decide. Cheap insurance on high-stakes factual claims.

### Divide-and-conquer

```
spawn_team(members: [
  { role: "part-1",      task: "Summarize pages 1-20 of {doc}. Write to {shared}/part-1.md. Final text: 1-paragraph recap." },
  { role: "part-2",      task: "Summarize pages 21-40 of {doc}. Write to {shared}/part-2.md. Final text: 1-paragraph recap." },
  { role: "part-3",      task: "Summarize pages 41-60 of {doc}. Write to {shared}/part-3.md. Final text: 1-paragraph recap." },
  { role: "synthesizer", task: "Read {shared}/part-*.md and produce a unified 5-bullet summary of the whole doc. Final text: the 5 bullets." },
])
```

## Cost and budget

- Each member is one `claude -p` invocation. 3 members ≈ 3× the cost + latency of a solo agent.
- Wall clock is max(member durations), not sum — they run concurrently. So 3 × 30s members ≈ 30-45s total, not 90s.
- Teams of >5 members rarely help. If you feel the urge, reconsider whether the task really needs that much parallelism or whether a smarter single-agent prompt would beat it.
- If the user is on a free-tier or explicitly cheap: prefer solo `spawn_agent` and accept the narrower output.

## Tailoring the sub-skills

The two pre-shaped patterns (`compare-options`, `research-trio`) are **templates, not hard-coded teams**. They tell you the shape; you write the actual task strings with the user's topic interpolated:

```
// read the template
read_skill("teams/research-trio")

// then spawn with your topic filled in
spawn_team(members: [
  { role: "scout",      task: "Search the web for authoritative info on **Postgres vector search libraries in 2026**. Drop a file…" },
  { role: "summarizer", task: "Read {shared}/scout-sources.json…" },
  { role: "verifier",   task: "Read {shared}/summaries.md…" },
])
```

Don't paste the template's task strings verbatim — those are examples. Rewrite with the user's actual subject.

## Anti-patterns

- **Using `spawn_team` when `spawn_agent` would do.** If there's only one role or no real data flow, you're paying overhead for nothing.
- **N calls to `spawn_agent` when you wanted a team.** You lose the shared scratch dir, the team-done wake-up, and the team-scoped `list_team` / `cancel_team` verbs. You'll get N separate wake-ups that are harder to coordinate.
- **Vague member tasks.** Every member has no conversation memory. A task like *"research the topic"* won't produce useful output. Pin down the deliverable shape.
- **Silent shared-dir contract.** If role B reads role A's file, both tasks must say so — specific filename, specific schema. Otherwise A writes one thing and B expects another.
- **Pasting `read_team_results` raw.** The output is structured for you, not iMessage. Synthesize: one takeaway sentence, then bullets.
- **Reaching for a team on a quick question.** "What's the capital of France" doesn't need a scout + verifier. Inline beats team beats solo agent for fast factual asks.
- **Ignoring the team-done wake-up.** The event is your cue to deliver. Don't just acknowledge it — finish the relay in that same turn.

## Quick reference

```
spawn_team(members: [{role, task}, ...])     → returns team_id, sharedDir
list_team(team_id)                           → per-member status
read_team_results(team_id)                   → all final texts, role-keyed
cancel_team(team_id)                         → SIGTERM every running member
```

Shared dir path: `<parent-sandbox>/teams/<team_id>/shared/`. You don't need to compute it — the real path is injected into each member's system prompt by the runtime. In your task strings, reference it as the placeholder `{shared}` (e.g. `{shared}/scout.json`). The agent sees the real path in its system prompt and resolves `{shared}` from context. `spawn_team`'s return value also surfaces `sharedDir` if you ever need it server-side.

Pre-shaped patterns worth reading before rolling your own:

- `read_skill("teams/compare-options")` — side-by-side evaluation of N named options.
- `read_skill("teams/research-trio")` — scout + summarizer + verifier pipeline for researched answers.
