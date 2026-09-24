---
"edmund-harness": patch
---

Scheduled and proactive wake-ups that start without the session's model conversation now carry the recent thread, as inbound cold starts do. The runner's persona-edit log says what happens (the session resumes and picks up the new prompt when its worker next starts) instead of announcing a fresh start that never happened.
