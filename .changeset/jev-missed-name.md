---
"edmund-harness": patch
---

Experimental `[group_addressing]`, off by default. It lets a group message through when it's meant for the assistant but doesn't say his name. Code picks the candidates: a swipe-reply to one of his messages, a word within two letters of one of his names, or a message soon after he spoke. Jev (`typesafe/jev-1.13` on OpenRouter) decides whether each one is for him. A message it lets through reaches his turn marked as un-named, and he still decides whether to answer. `"shadow"` mode only records decisions, to `data/addressing.jsonl`.

On the hand labels, a 0.6 threshold caught 37 of 49 missed messages and woke him wrongly for 17 of 708 other messages. `scripts/addressing-calibrate.ts` reruns that measurement after the wording or model changes.

Swipe replies now carry their parent. iMessage stores the parent in `thread_originator_guid`, which the watcher never read, so every inline reply arrived with no parent: 91 of 91 in 90 days.
