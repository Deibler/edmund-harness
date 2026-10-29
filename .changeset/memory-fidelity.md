---
"edmund-harness": minor
---

Keep what was said in reach after the conversation is compacted.

- The harness now reads the compaction boundary Claude Code streams. It records every compaction, the CLI's own mid-turn ones included, and measures context from the calls after it. Before, the turn still reported its pre-compaction size, so the harness compacted the freshly compacted conversation again: 31 of 60 harness compactions in one DM ran on a context already under 190k.
- After every compaction, automatic or manual, a SessionStart hook puts the chat's latest messages back, verbatim from chat.db. A summary keeps pointers, not words.
- The harness's own `/compact` asks the summary to keep the person's own words, decisions, corrections and the final text of anything sent.
- Recall in a DM now starts where the model's verbatim sight ends: the thread re-injected after the last compaction, or a cold start's history. It used to skip a fixed window. the operator's DM compacted about every 1.2 hours, so with the old 48-hour window 140 of the previous two days' 144 messages were in neither the conversation nor recall.
- Recall's diversity step compares relevance and similarity on one scale. Before, a fused ranking's relevance was so small that every pick after the first went to the hit least like the others.
- Recall lines name speakers the way history does ("You", contact names) and drop the indexer's duplicate date header.
- Operating principles are one rule each, at most 240 characters, checked where they are written, with one retry. Passes had been folding new rules into old ones until single principles ran past 1,300 characters.
- `scripts/recall-eval.ts` replays hand-labelled questions from a real conversation and reports how many needed messages reach the model. On 41 questions from the operator's DM: 6 before this change, 29 after.
