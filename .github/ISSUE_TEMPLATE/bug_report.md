---
name: Bug report
about: Something behaved wrongly
---

**What happened**

**What you expected**

**How to reproduce**
Steps, or the message that triggered it.

**Environment**
- macOS version:
- Bun version:
- Provider and model (`[claude].model`):
- Bridge commit or version:
- SIP status (`csrutil status`):

**Log excerpt**
Run `edmund logs --session <handle>` and paste the relevant lines. Redact
phone numbers, emails and names first.

**Did the message land somewhere?**
If this is about delivery, check `chat.db` for the message GUID before
reporting that it was not sent.
