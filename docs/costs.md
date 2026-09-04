# Costs

What costs money, what drives it, and which levers actually move it. Figures
are deliberately absent from this page: your model, your conversations and
your prices differ. The shape is what transfers, and `data/spend.db` lets you
measure your own.

## What you pay for

| Thing | Paid to | Driver |
|---|---|---|
| Conversation turns | Your Claude Code or Codex subscription, and whatever it meters | Tokens in the prompt on every turn, times turns |
| Maintainer, consolidator, ghost, curator, evals | Same subscription, smaller models by default | How often each runs; all are configurable and most are off in the example config |
| Image, video, audio generation | OpenRouter, or the person's own wallet if credits are on | Per generation; capped per model by `[openrouter]` |
| Transcription, video understanding | OpenRouter | Per voice memo or video |
| Web search | Brave | Per search |
| SMS | Twilio | Per segment, both directions |
| Tunnels | Cloudflare | Free tier covers a personal deployment |

## The shape of turn cost

Measured over four months of one deployment's log, median cost per turn rose
steeply with context: the largest context bucket cost several times the
smallest. Two things follow.

**Fixed prompt overhead is multiplied by every turn of every conversation.**
The system prompt and `SOUL.md` are in every turn. A person file is in every
turn of one conversation. A token in the global layer therefore costs on the
order of fifty times a token in one person's file. When you want to add
something to the prompt, ask which layer it belongs in, and prefer the
narrowest.

**A compaction is expensive on the turn after it.** Compaction rewrites the
cached prompt prefix, so the next turn pays cache write prices instead of cache
read prices. In one measurement the turn after a compaction cost about two and
a half times a normal one. The threshold in `[claude.auto_compact]` is
therefore cost control. Raising it to keep more context in play makes every
turn in the larger bucket cost more, for the whole time the conversation
stays large.

## Levers, in order of effect

1. **Shrink what is in every prompt.** Archive `SOUL.md` subsections. Keep
   `IDENTITY.md` to a page. Move standing knowledge into domain notes, which
   are reached through recall only.
2. **Let the archiver work.** Person files over 8 KB have their oldest
   observations moved out of the prompt and into the index. If a file keeps
   growing, a section is probably exempt from the gate; that is a bug to fix,
   not a limit to raise.
3. **Consolidate.** Ten principles cost less than a hundred observations and
   are more useful.
4. **Use the warm pool.** Resident workers keep the prompt prefix cached
   between turns. Without it, every turn re-reads the prefix.
5. **Choose satellite models deliberately.** The maintainer, prescreen and
   judge default to small models. The ghost defaults to a large one because
   the decision is judgment; you can lower it.
6. **Turn off what you do not use.** Proactive outreach, the curator, evals
   and announcements each cost a little every day. The example config ships
   with the first three off.

## What does not help

- Raising the compaction threshold. See above.
- Passing an explicit context window for Codex. Leave it unset and let the CLI
  use its own metadata; a hardcoded number is wrong the day the model changes.
- Estimating costs. The ledger records the CLI's own figure or nothing.

## Measuring your own

```sql
-- median-ish cost by context bucket, DM turns only
select (ctx_tokens / 100000) * 100 as bucket_k,
       count(*) as turns,
       round(avg(cost_usd), 3) as mean_usd
from turns
where subsystem = 'turn' and session_key like 'imessage:dm:%'
group by bucket_k order by bucket_k;
```

Run it against `data/spend.db` with any SQLite client. Compare the buckets. If
the top one is many times the bottom, your conversations are living in
expensive territory and the levers above are where to start.

## Generation credits

If you let other people generate media, the question becomes who pays. The
credits system gives each DM its own provisioned OpenRouter key whose limit is
what that person paid through Stripe, minus fees, so the operator is out of
pocket by roughly a cent on the dollar rather than by everything. Balances
and payments are read live; nothing is bookkept locally. Details in
[generation-credits.md](generation-credits.md).
