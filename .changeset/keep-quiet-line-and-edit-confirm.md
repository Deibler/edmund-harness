---
"edmund-harness": patch
---

`KEEP_QUIET` on the first or last line of a reply now vetoes the whole reply, so narration beside the sentinel is dropped instead of shipped. `edit_message` and `unsend_message` confirm the outcome against chat.db and report a request Messages accepted but never applied as an error instead of success.
