---
name: deep-research
description: Multi-agent deep-research orchestrator. Plans 2-6 sub-queries, fans out parallel researchers, synthesizer merges into a brief + 3-bullet iMessage summary. Use when one-shot web_search won't cover the angles.
---

# Deep Research

Heavy-lift research as a single tool call. Spawns a team of sub-agents
in parallel — each takes one angle of the question, hits the web, and
writes a finding. A synthesizer waits for everyone, merges, dedupes,
and produces both a 3-bullet summary for iMessage and a longer brief
for follow-through.

---

## When to reach for this

- The user said "research X", "dig into Y", "what's the state of Z".
- One-shot `web_search` would miss angles (overview + recent + critique + alternatives).
- The answer should be defensible — multiple sources, dedupe across them.
- The user is going to read the result later (not immediately) — deep-research
  is async, takes 2-7 minutes depending on depth.

**Don't** reach for this on:

- Factual one-liners ("who won the Warriors game last night") — use `web_search`.
- The user is sitting watching their phone — they'll get bored. Use `web_search`
  + a follow-up.
- The question is fully internal ("what did Riley say last week") — use
  `search_history` / `semantic_search`.

## How to call it

```
deep_research({
  question: "what's the current state of agentic coding tools in 2026, and where are people landing on Claude Code vs Cursor vs Devin",
  depth: "standard"   // quick | standard | thorough
})
```

Depth → fanout → expected wall-clock:

| depth      | fanout | wall-clock      |
|------------|--------|-----------------|
| quick      | 2      | ~1-2 minutes    |
| standard   | 4      | ~2-4 minutes    |
| thorough   | 6      | ~4-7 minutes    |

The tool returns immediately with a team id, the planned sub-queries,
and the shared-dir path. It does **not** block. The harness fires a
team-completion event when every team member has settled.

## What to do with the return

1. **Tell the user it's running.** Don't go silent. One sentence:
   "kicking off a deep dive, give me a few minutes — I'll come back
   when the team's done."
2. **Don't poll.** The team-completion event will wake you up. If you
   want to peek mid-flight, call `list_agents(status="running")` once.
3. **When the wake-up event fires**, read the synthesizer's
   `result.md` for the 3-bullet summary. If the user asked for depth,
   also `Read` `<sharedDir>/brief.md` for the long version.
4. **If the brief is long**, share it via the `instant-share` skill so
   the user can read it on their phone without scrolling 60 bubbles.

## Subagent behavior

Each researcher gets one sub-query and is told to:
- Use `web_search` to find 3-5 sources.
- Use `web_fetch` on the most relevant.
- Write a markdown `finding-<role>.md` into the team's shared dir.

The synthesizer waits, reads every `finding-*.md`, dedupes URLs,
resolves contradictions, and writes:
- `brief.md` — full markdown (title, TL;DR, findings, sources)
- `summary.txt` — three iMessage-fitting bullets (≤120 chars each)
- `result.md` — same as summary.txt (so the model's `read_agent_result`
  call gets the iMessage-fitting version)

## Planner

Sub-queries come from a Haiku planner by default — cheap, fast, picks
better angles than a hardcoded template. Falls back to a heuristic
decomposition if Haiku is unreachable or you pass
`use_heuristic_planner: true`.

## Cost notes

Each researcher is a separate Sonnet `claude -p` invocation with full
MCP access. Fan-out × tokens per researcher = the bill. Use `quick`
when you're uncertain whether the user even wants the depth.
