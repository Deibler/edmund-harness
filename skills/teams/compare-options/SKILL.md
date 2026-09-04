---
name: compare-options
description: Parallel-investigator team for side-by-side comparisons. One agent per option, investigating in isolation so their findings don't contaminate each other. Use when the user asks "which of X, Y, Z should I pick?" and each deserves a real look.
---

# compare-options

N agents, each investigating one option with the same set of questions, so the comparison is apples-to-apples.

## When to use

- "Should I use Framework A or Framework B?"
- "Which of these 3 places has the best [criterion]?"
- "Compare these 4 iMessage servers."
- Any question where the user named the options and wants them evaluated side-by-side.

Don't use for:
- Open-ended discovery ("what frameworks exist for X?") → that's `research-trio`.
- One-option deep-dives → single `spawn_agent` is lighter.

## The pattern

Spawn one agent per option, all with the SAME evaluation criteria. Each writes its findings to `{shared}/<option-slug>.md`. No cross-talk; each agent doesn't know the others exist.

```
spawn_team(members: [
  {role: "option-a", task: "Evaluate {OPTION_A} against these criteria: <criteria list>. Write findings to {shared}/option-a.md with sections per criterion. Final text: one-paragraph verdict."},
  {role: "option-b", task: "Evaluate {OPTION_B} against these criteria: <criteria list>. Write findings to {shared}/option-b.md with sections per criterion. Final text: one-paragraph verdict."},
  {role: "option-c", task: "Evaluate {OPTION_C} against these criteria: <criteria list>. Write findings to {shared}/option-c.md with sections per criterion. Final text: one-paragraph verdict."}
])
```

## Criteria matter

Agents investigate what you tell them to. Write the criteria list explicitly in every member's task — same list for each:

- *"Install ease (1-10)"*
- *"Active maintenance (last 6 months)"*
- *"macOS 15 Sequoia compatibility"*
- *"License"*
- *"Known issues"*
- Whatever the user cares about.

If criteria differ per option, you're not really comparing — split into separate `spawn_agent` calls.

## After completion

`read_team_results(team_id)` returns each agent's verdict. Synthesize:

1. One-sentence recommendation ("go with X because Y").
2. Short side-by-side: one bubble per option, 2-3 words on each criterion.
3. The main tradeoff between the top 2.
4. If the user wanted raw data, offer to send the full markdown files via `send_attachment`.

## Tradeoffs

- N API calls. For 3 options this is ~$0.10-0.30, 30-60s wall clock. For 5+ options, think about whether this actually helps vs a single well-prompted research-trio.
- Strongest when criteria are fixed and options are named. Weak when the user is still deciding what criteria matter.
