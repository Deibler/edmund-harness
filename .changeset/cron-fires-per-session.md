---
"edmund-harness": patch
---

Scheduled fires for one chat no longer hold up other chats. Before, the scheduler waited for each fire, a whole model turn, before starting the next. On 2026-09-25 a 38-minute background-job turn in one DM delayed the mirror's severe-weather check by 34 minutes, so it was skipped as stale. Each session's fires still run one at a time, in order.
