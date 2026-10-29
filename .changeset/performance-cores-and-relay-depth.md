---
"edmund-harness": patch
---

Run the daemon on the performance cores again, and keep warm workers through relays.

- The launchd template said `ProcessType Background`. The installed plist had been set to `Interactive` by hand in July, but a reinstall on 2026-10-25 rendered it again from the template, and since then the daemon and everything it spawns (model workers, MCP servers, Messages) ran on the efficiency cores with throttled I/O. With only the priority changed, a worker resuming the operator's 1.3 GB conversation reached the CLI's `init` event in 5.6–6.1 s throttled against 2.0–2.4 s normally (n=5 each), and a new conversation in 3.1–3.5 s against 1.5–1.7 s. Live cold loads had reached 9.6–14.8 s. The template now says `Interactive`, a test pins it, and the daemon logs `[boot] qos` when it finds itself throttled anyway.
- A relay's depth (the loop guard in `bridge/relay.ts`) rode in the worker's spawn environment, so it was part of the worker's rebind key. Every relay into a session recycled its warm worker, and the session's next ordinary message recycled it back: two cold spawns per relay, 243 of the 1,919 recycles logged since May. `runModel` now records each turn's depth in the state store and `message_contact` / `ask_contact` read it when called, so the depth no longer touches the worker.
