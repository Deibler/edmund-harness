---
"edmund-harness": patch
---

Offer a kitchen on the first food question, explain it at setup, and follow up through the first week.

- **The offer is actually made now.** A chat with no kitchen used to get an error from every kitchen tool, carrying an offer gated on "the second or third time" somebody asked. Between 2026-08-17 and 2026-10-20 that error came back 43 times across about 30 food questions from 7 chats, and the offer was made twice. Now the tools answer normally: answer the question in full first, then offer in the same message, with what it is, what they get and what it takes.
- **Never hold the answer back for setup.** The old text said not to answer "from nothing", and the one time it was followed somebody waited 46 minutes for a bake time.
- **Asked at most twice, and a no is final.** `data/kitchen/prospects.json` records food questions, offers and a no (`kitchen_onboard action:"decline"`). An unanswered offer is made once more after a week, then never. An offer that chat.db shows never reached the chat does not count.
- **Small groups.** A group of two or three is offered a kitchen only when Edmund judges they share one, such as a couple; a bigger group never is. `start` in a group also links each member's own chat, unless they already belong to a kitchen.
- **How it works, at setup.** When the link goes out, Edmund explains the one habit (a photo of the receipt), that they can just ask what to cook, and that there is nothing to keep up.
- **First-week check-ins.** `start` queues three wake-ups in the chat where setup happened: day 1 a dinner from their shelves, day 4 a receipt nudge, day 7 a short recap with an offer of dinner texts. Each reads the ledger when it fires (`kitchen_onboard action:"checkin"`) and stays quiet when it is no longer needed.
