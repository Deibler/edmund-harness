---
"edmund-harness": patch
---

The recall index's keyword (FTS) table is repaired only by the daemon, and the repair runs as one transaction. Before, every process that opened the store, including each MCP server and each generated image, rebuilt the table whenever the counts disagreed. Those rebuilds ran without a lock timeout and outside a transaction, and they interleaved with the daemon's writes. On 2026-09-24 the rowid map held 933 entries for 104,658 rows, so updates added duplicate entries and each `semantic_search` took 5–34 s.

What changed:
- The store opens through `openDb`, which sets `busy_timeout`.
- The boot check also catches a same-sized map that points at the wrong documents.
- The indexer skips `pending.json`, which the kitchen drain rewrites every pass, so it no longer re-embeds three files a minute.
