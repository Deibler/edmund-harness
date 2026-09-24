---
"edmund-harness": patch
---

The screen's safety check no longer hears a reminder the model scheduled as Edmund's own scheduler. Since the turn-trigger context was added, any cron job that started a turn reached the check as "Edmund's own scheduler started this turn", with carrying it out counted as requested, deletes above a note's sentinel allowed, and the on-screen-instructions question waived. `schedule_reminder` and `update_reminder` store the model's text word for word, and data-trigger fires carry the model's brief and fetched data, so a model could write itself that permission a minute ahead. Cron jobs now record whether harness code wrote their text (`harness_written`, default 0, older rows 0). Only kitchen wakes and their retries set it, and rewriting a job's text clears it. The check gets the scheduler framing only for those jobs.
