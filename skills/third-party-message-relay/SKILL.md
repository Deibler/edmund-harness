---
name: third-party-message-relay
description: Use when the user asks the assistant to actually send (not draft) a message to a different, named person on their behalf — a status update, heads-up, or prank — as a one-off or a scheduled/drip sequence.
---

This task is different from ghostwriting content for the user's own use: here the assistant executes an outbound send to someone who is not in the current conversation. Treat every step as consequential because it lands on a real person's phone and can't be recalled.

1. Resolve the actual recipient. When the user says "tell him/them/[name]", identify that person's own contact/chat — do not post the relay into the current thread or a group unless the user explicitly wants the group to see it. If which contact "him"/"them" refers to is ambiguous, ask before sending.

2. Nail down exact content before sending.
   - For plain status/location relays ("tell him we're at the exchange", "text them wya", "we'll be there in seven"), keep the wording close to what was given — it reads as coming from the user, so don't add information or embellish.
   - For jokes/pranks, the specific inside detail is the whole point (e.g., a joke built on someone's actual lost wallet). Use that concrete detail rather than a generic substitute, and match the requested tone exactly (funny, eerie, casual, etc.) — ask a clarifying question if the tone or key detail is missing rather than guessing.

3. If the request includes a schedule ("every 25 minutes", "from 9 to 6", "after 8 texts send X"), before building anything capture:
   - start time and interval
   - the message for each step, or the rule for how it varies/escalates between steps
   - the end condition (fixed count, time window, or a specific final message)
   - how the user can cancel mid-sequence
   Read these four back in one line for confirmation before scheduling — a multi-hour drip to someone else's phone is hard to walk back once started. Use the scheduling/cron capability to fire each send; don't try to stay resident in the conversation counting minutes.

4. Before executing, especially for a prank or anything that could land badly out of context, confirm recipient and exact first message if there is any doubt at all.

5. After sending, verify the message actually landed by checking the real message store/thread rather than trusting a successful-looking return value from the send action.
