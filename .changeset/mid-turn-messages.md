---
"edmund-harness": patch
---

Edmund sees a message that arrives while he is working, and can answer it then instead of when the task ends.

A message for a conversation with a turn in flight used to wait in a queue until the turn finished, unless the model thought to look. Over 30 days, 330 turns ran past 3 minutes (57 in groups, 35 of them past 10 minutes), 75 had someone waiting, and `handoff_current_work` was never called. In a group, the person waiting was often not the one who asked for the work.

The CLI accepts a message mid-turn and hands it to the model at its next tool step, and in those long turns a step came every 4.9 s at the median. So the daemon now writes the message to the running worker as `[SYSTEM — a new message arrived while you're working]`, with the sender and message id, and the prompt tells the model to answer it with `send_message` before its next tool call and carry on. In a probe on Opus, a second person's question was answered 19.7 s after they sent it, while the first person's three-step job ran to the end. Before, they would have waited for the whole job.

- The worker writes a message only while a tool step is running, so it always joins the turn; the CLI's echo of it tells the worker the model saw it. If one misses the turn anyway, the worker is retired before the CLI can start a turn for it that the next message would be mistaken for.
- A message the model saw mid-turn gets no follow-up pass and no turn of its own afterwards; one it did not see, or one parked by a turn that failed, is answered as before.
- Photos and files still wait for the end of the turn, since only text can join it; a voice note goes as its transcript.
- Scheduled and wake-up turns are unchanged: a message still waits for them (14 of 499 mid-turn arrivals in 30 days).
