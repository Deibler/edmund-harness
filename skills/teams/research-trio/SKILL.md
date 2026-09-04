---
name: research-trio
description: Three-agent research pipeline — scout finds sources, summarizer distills them, verifier sanity-checks. Use when the user wants a researched answer on a non-trivial topic and you want balanced depth + quality. Call via `spawn_team` with these three roles; tailor the tasks to the specific topic.
---

# research-trio

A three-role team for researched answers. Each role has a clear hand-off via the team shared scratch dir.

## When to use

- "Research X and tell me about it" (substantive topics, not quick-lookups).
- "Compare these N things" where primary sources matter.
- "What's the current state of Y?"
- Anything where a single-shot summarize would be too shallow or unverified.

Don't use for:
- Simple factual lookups → just answer or `summarize` the URL inline.
- Media generation or creative writing → this is a research pattern only.

## The three roles

**scout** — finds primary sources.
Typical task shape: *"Search the web for authoritative info on {topic}. Drop a file at `{shared}/scout-sources.json` with 8-12 entries: each `{url, title, one-line-summary, date, source-type}`. Prioritize primary sources (official docs, announcements, papers) over aggregators. Your final text: one-sentence recap plus the path to scout-sources.json."*

**summarizer** — distills scout's findings.
Typical task shape: *"Read `{shared}/scout-sources.json`. Pick the 5 most relevant entries for the user's question. For each, open the URL and produce: `{url, 3-bullet takeaway, one-line relevance}`. Write to `{shared}/summaries.md`. Your final text: the 5 takeaways, tight."*

**verifier** — sanity-checks summarizer's picks.
Typical task shape: *"Read `{shared}/summaries.md` and the source list at `{shared}/scout-sources.json`. For each of the 5 summaries: flag anything that looks stale (>2 yrs old on a fast-moving topic), contradicts other entries, or over-claims beyond what the source supports. Your final text: which picks are solid, which need caveats, which should be dropped."*

## Calling it

```
spawn_team(members: [
  {role: "scout",      task: "<scout task string, topic interpolated>"},
  {role: "summarizer", task: "<summarizer task string, topic interpolated>"},
  {role: "verifier",   task: "<verifier task string, topic interpolated>"}
])
```

Edmund interpolates the topic into the task strings. There's no separate template engine — the skill's job is to give you the shape; you write the strings.

## After completion

When the team-done event fires, `read_team_results(team_id)` gives all three results. Synthesize into one reply:

- Lead with a one-line answer to the user's actual question.
- Back it up with 3-5 of the strongest findings from summarizer.
- Fold in verifier's flags ("caveat: two of these are from 2023, so take the numbers lightly.").
- Don't mention "the team" or the roles. The user sees a clean researched answer, not the machinery.

## Tradeoffs

- Three API calls instead of one. Budget ~30-90s wall clock, ~$0.05-0.20 in tokens.
- Worth it when the answer needs sources + quality gate. Overkill for quick factual lookups.
- Sequential-feeling even though members run concurrently — scout's output lands before summarizer typically finishes its first tool call, so practical sequencing works out.
