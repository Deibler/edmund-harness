---
"edmund-harness": patch
---

A FaceTime call no longer goes deaf when speech recognition fails partway through. The daemon starts a fresh recognition session (up to 3 times a call). If it keeps failing, the call is hung up and the operator is told why, instead of the caller talking to nobody. On 2026-10-29, Apple's recogniser rejected a session ("RecogRejected") two seconds into a call that came three seconds after a rebuilt listener launched, and nothing more was heard for the remaining 28 s. An early finalize on a cold recogniser did not reproduce it, so the cause is unconfirmed; this covers any cause.
