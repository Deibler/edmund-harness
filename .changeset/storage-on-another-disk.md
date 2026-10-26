---
"edmund-harness": patch
---

Sandboxes and conversation transcripts can live on another disk. Keep `sandbox/` and `persona/sessions/` as symlinks to it: the session links now also cover the symlink-resolved path Claude Code uses to name transcript folders, so conversations keep resuming, and the daemon refuses to start when the disk is not mounted.
