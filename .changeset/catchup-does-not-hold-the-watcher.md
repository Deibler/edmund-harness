---
"edmund-harness": patch
---

After a restart, live messages are answered while the boot catch-up is still running. Before, the watcher started only after every catch-up turn had finished. On 2026-09-24 two long turns in one DM kept every other chat unanswered for 87 minutes.

Catch-up now:
- reads the backlog and writes a durable ack for each row;
- hands the watcher its cursor at once, and runs the turns in the background;
- merges each chat's orphans and backlog into one turn;
- adds a live message to its chat's catch-up turn if that turn hasn't started, so the chat is answered once, oldest first.

The recovery loops still start only once catch-up has drained.
