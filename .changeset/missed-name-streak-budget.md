---
"edmund-harness": patch
---

The group missed-name check now wakes the assistant less often by mistake, and a string of misfires can't feed itself.

- **Messages that open with another member's first name.** Jev is told when a message starts with another member's first name. It gets only that fact, never the name. Senders reach Jev as letters, so it had no way to know "Sam, who's playing Sunday?" was said to Sam.
- **Right after he has spoken, both scores must be high enough.** "Wants a reply" must reach 0.7 (it was 0.6), and "said to him" must now also reach 0.5. Over 840 labels, wrong wakes fell from 29 to 8, and real messages caught went from 87 to 82 of 100.
- **A budget per run of un-named wakes.** Each wake right after he has spoken costs 1 minus how often a message with that score was really for him. The rate comes from a measured table: Jev's scores are not calibrated on this question, and a 0.75 was right about half the time. A run stops once it reaches `streak_budget`, 0.6 expected wrong wakes. A confident back-and-forth barely spends it. The budget resets when someone says his name or swipe-replies to him. The streak is read back from chat.db and the decision log, so a restart loses nothing.
- **He sees the run.** His note says how many times in a row he has been woken without his name.
- **Calibration.** `scripts/addressing-calibrate.ts` writes the measured table for the current question wording.

New config keys: `addressed_floor` and `streak_budget`. The approach is in `docs/group-addressing.md`.
