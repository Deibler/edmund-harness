---
"edmund-harness": patch
---

SMS conversations stop looking empty to the history tools and proactive outreach, scheduled reminders into a group say who is in it, and people without a contact entry can be named.

- **History tools read the SMS transcript.** `get_thread_context`, `search_history`, `get_message` and `catch_me_up` asked chat.db, which has no rows for a Twilio conversation, so an SMS group holding dozens of messages answered "no earlier messages in this chat". They now read the SMS store for `sms:` sessions. `list_attachments` says SMS media is not downloaded instead of reporting none.
- **Proactive outreach reads it too.** The ghost judged an SMS group a "fresh session with zero message history"; it now gets the transcript, and an SMS DM no longer borrows that person's iMessage reactions and attachments.
- **A cold wake-up into a group carries the roster.** Scheduled, proactive and recovery wake-ups had the recent thread but not the `Participants:` line an inbound turn gets, so a reminder could address someone who had only been talked about. Inbound turns and wake-ups now share one roster helper.
- **`name_person`** records what someone goes by when no contact entry names their number. Rosters and transcripts then show `Pat (+1…)` instead of a bare number. A learned name is display-only: it never answers `displayName`, which decides SMS admission. It cannot reuse a contact's name or name Edmund's own addresses, and it is vetted to letters, spaces and basic punctuation.
