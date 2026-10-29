---
"edmund-harness": minor
---

Answer faster without changing models.

- Workers run with `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`, so a conversation's transcript is cut back to its live part at each compaction. The operator's DM transcript had reached 1.3 GB, of which 4 MB was live. A resume of that file loaded in 1.6–2.2 s; trimmed, in 0.4 s.
- Recall no longer waits behind the indexer:
  - Person, group and self files re-embed only chunks whose text changed, where every append to an archive used to re-embed all of it (300–650 chunks).
  - Live queries go before queued index work, and index batches are 2 texts so a query never waits long for one in flight.
  - The embedding model is loaded while a new message's debounce window runs.
  - One BM25 lookup serves every recall leg.
  - The coverage document counts that blocked the daemon on every tick are computed every 10 minutes.
- Recall per question on the replay eval: 145–171 ms median, against 323–342 ms, with identical results on all 81 records.
- The memory governor evicts one least-recently-used idle worker per sample at its soft limit, sparing any used in the last 10 minutes, instead of every warm worker. Those flushes caused 67 of 156 cold starts in the operator's DM from 10-20 to 10-29. Worker pids now show in pool stats.
- A session that needed the browser keeps it on its next spawns for a day, so its next link no longer recycles the worker.
- Cold spawns log how long the CLI took to load and to the first token, and the transcript size they resumed.
- `scripts/recall-eval.ts` reads compaction times from the daemon log (`--compactions-from-log`), and matches needles with a plain loop: Bun 1.3.9 returned a wrong `findIndex` result mid-run.
