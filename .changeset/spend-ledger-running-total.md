---
"edmund-harness": patch
---

The spend ledger now books each turn's actual cost. The Claude CLI's `total_cost_usd` is the running total for the whole model session, carried across process restarts. Turns, cron fires and proactive fires resume a conversation, and they were booking that total as each turn's cost. One DM logged $99.03 for a turn that cost $0.11, and the ledger summed to 4-11x the real spend.

Those callers now pass the total as `sessionTotalUsd`, along with the model session id, and the ledger books the rise since that session's last total. When that can't be known, the cost is recorded as unknown (null):
- the total dropped, because a killed process restored an older total;
- or a resumed session has no earlier total in the ledger.

The log field is now `session_total` instead of `cost`. `scripts/spend-ledger-repair.ts` repairs rows booked before the fix; it dry-runs by default, and `--apply` backs up `spend.db` first.
