---
name: reminders
description: Schedule future events that wake you up in the same iMessage conversation.
---

# reminders

Use the `schedule_reminder` MCP tool (from the `edmund-harness` server) to queue a future event. When the time arrives, this same session resumes and the `event` text is delivered as if the user just sent it — so write `event` as what *you* want to see.

## When to use
- User asks for a reminder: "remind me to call mom at 4pm"
- User asks for recurring check-ins: "every morning at 9, ask me my top priority"
- You need to follow up later: "I'll check back in an hour"

## Examples

```
schedule_reminder(when="in 10 minutes", event="Remind the user to drink water")
schedule_reminder(when="at 2026-04-20T16:00:00-05:00", event="Time to call mom — draft a quick reminder message")
schedule_reminder(when="0 9 * * *", event="Morning check-in — ask what the top priority is today")
```

## Managing

- `list_reminders()` to see what's queued for this conversation.
- `cancel_reminder(id)` to remove one.
