---
"edmund-harness": patch
---

What a turn shows the model is accurate again: recall is on-topic, group turns see what was said, and times, attachments and tools are described as they are.

- **Recall without keyword noise.** Unprompted recall let a keyword match in under the 0.7 similarity floor. Replaying 128 real inbound messages: 15 hits a turn, 86% of them under the floor (median 0.57), matched on a shared word. Recall now holds every hit to the floor and uses the keyword ranking only to order them: 3.3 hits a turn, none under the floor, a fifth of the characters. `semantic_search`, which the model calls and reads scores from, keeps the rescue.
- **Group turns see the room.** "You haven't replied in this thread yet" sat above Edmund's own reply in 39% of group turns, because the send was stamped after chat.db dated it; it is now read from the thread's rows. A message folded into a running turn is labelled with its own writer, not the turn's first sender. Recall in a group picks up where the shown thread starts, so earlier same-day chatter is no longer in neither. A scheduled or proactive wake-up into a warm group carries what members said since the last turn (32 of 66 fires had missed it). A session Edmund posted in recently is no longer reset as idle because nobody wrote to him for three days.
- **Times read the same everywhere.** Scheduled events state their times in Eastern instead of UTC, history lines older than six days carry their date, and `schedule_reminder` takes a bare ISO timestamp (32 of 47 logged failures), reading one without an offset as Eastern.
- **No false promises.** A worker without `chrome-devtools` is told so and how to get them on the next turn, instead of being promised them (43 of 101 lookups failed). An attachment that never finished downloading is described as not coming, instead of promising a follow-up turn that never ran.
