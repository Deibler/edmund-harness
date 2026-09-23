---
"edmund-harness": minor
---

The kitchen no longer writes Apple Notes itself. The background sync that drove a signed-in Chrome on icloud.com to rewrite each household's note, and the invites it sent the same way, are gone. Edmund now keeps each household's shared note up to date on screen, in the Notes app, with the computer-use tools: changing only the lines that differ and leaving ticks alone. When a household's list changes and then holds still for two minutes, the watch pass wakes that household's session to do it, with the lines the note should have. It only wakes a chat that the computer-use policy gives Notes, and each list wakes at most three times. `kitchen_shopping` loses `notes`, `share` and `shareWith`, and gains `noteWritten`, which Edmund sets once the note matches.
