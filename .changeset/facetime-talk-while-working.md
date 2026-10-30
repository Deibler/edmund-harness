---
"edmund-harness": patch
---

FaceTime calls: Edmund answers faster, never goes quiet to run commands, and hears every call.

- While a call is live his conversation runs at `[facetime] effort` (default `low`) instead of the DM's effort. A spoken reply waits on the model's thinking: at `xhigh` the first live calls took 1.7-7.2 s per reply before the first word. The model stays the same, so the conversation and its prompt cache carry across; the worker is respawned once as the call rings and once after it ends.
- On a call, `Bash`, `WebFetch` and `WebSearch` are off for his own turns, so slow work goes to a background agent (`spawn_agent`) while he keeps talking, and its result comes back into the call. On the first live call, asked whether hanging up would cut him off, he ran shell commands for 40 s in silence and hung up without saying goodbye.
- `end_call` waits (up to 15 s) for what he has already said to finish playing before it hangs up.
- When a call ends, speech still queued is dropped and a reply still streaming is no longer spoken into the dead line; it goes out as a text, as before.
- Every call is heard, not only the first after the listening helper starts: stopping recognition left its audio format behind, and the next call skipped starting the recognizer because of it.
