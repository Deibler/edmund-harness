---
name: ghostwrite-text-on-behalf
description: Compose or send a text message for the user — a relay, a joke, a reply to someone specific, or a scheduled sequence — matched to the real tone of the sender or recipient rather than a generic voice.
---

Use this whenever the user asks you to text someone for them, draft what they should say, or reply to a message on their behalf. This spans everything from a one-line relay ("tell him we're at the exchange") to a joke played on a roommate, a carefully-worded message to an ex, or a multi-part scheduled prank campaign. Treat these as one job with a shared procedure:

1. **Figure out who the message needs to sound like.** Two different cases require opposite handling:
   - If the message should sound like it's coming from the recipient's real friend/roommate/partner (i.e., the user), pull recent real messages between the user and that contact (or the contact's own messages in shared chats) and match their actual phrasing, abbreviations, and humor — don't invent a generic "friendly text" voice. If told to study someone's "humor and mannerisms," that means read their actual message history first, not guess.
   - If the message is understood by the recipient to come from an assistant (some contacts already refer to "your Edmund"), a more neutral tone is fine — check how the chat has addressed you before.

2. **Preserve authenticity signals on purpose.** Do not auto-clean the draft. If the user's real texting style includes lowercase, missing punctuation, or shorthand ("tht", "smt", no autocorrect), keep it — those imperfections are often the whole point, because a too-polished message reads as obviously not from the user. If the user flags this explicitly, treat it as a hard constraint, not a suggestion.

3. **Get the payload exactly right before sending.** For a one-off message, confirm the exact wording and the exact recipient — a wrong tone or an extra flourish can ruin a joke or misfire on something sensitive (e.g., a message to an ex). For anything that reads as a prank, in-joke, or emotionally loaded message, prefer surfacing the draft for a quick confirm rather than sending blind, unless the user has clearly pre-approved the whole flow.

4. **For scheduled or multi-message sequences** (e.g., a prank campaign, a countdown, a recurring nudge), nail down as an explicit spec before building it: start time, interval, how many messages or what end condition, and the content/tone of each stage (including any "reveal" message). If the user revises the tone ("make it eerier", "more ominous"), apply that consistently across every message in the sequence, not just the one just discussed.

5. **Keep simple relays simple.** If the ask is just "tell him X" or "text them saying Y", send a concise, faithful relay — don't pad it into a longer message than asked for.

Gotcha: a message drafted to *sound like the user* and a message drafted to *sound like an assistant relaying for the user* need different voices — picking the wrong one is the most common way this goes wrong.
