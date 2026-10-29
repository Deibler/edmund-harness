---
"edmund-harness": patch
---

`scripts/launchd/service.sh install` no longer leaves an agent unloaded. `launchctl bootout` returns before the job has finished unloading, and the bootstrap right after it failed with "Bootstrap failed: 5: Input/output error". Under `set -e` the script then stopped with the old job gone and the new one never loaded, which took the daemon down on 2026-10-29 until it was bootstrapped by hand. Every install now waits for the unload first; against real launchd the old sequence fails with error 5 and the new one loads the job.
