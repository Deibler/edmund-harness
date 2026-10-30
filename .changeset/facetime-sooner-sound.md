---
"edmund-harness": patch
---

FaceTime replies start sooner. Measured on the 23:24 live call: 14 exchanges with Smart Turn scoring every pause.

- **A finished sentence is said once the text pauses for 200 ms on it,** instead of waiting for the next sentence to begin. The last line before a tool call ("On it, texting you now.") had waited for the whole tool: 4.8 s while a text message was written and sent. The instruction to say something before a tool could not work without this.
- **The call envelope asks for the spoken answer first,** with bookkeeping such as `remember_about_person` after it. One reply was silent for 3 s while a memory note was saved first.
- **An "unfinished" verdict waits 0.8 s, not 2 s, then settles the transcript at once.** On that call Smart Turn scored 13 of the 21 pauses correctly and called 5 complete sentences unfinished (0.03-0.45), against 0.98/0.97 on the first two and 0.73 on `say` speech. Feeding it only the audio since Edmund last spoke scored worse (9/21), so the window is not the cause. Ending a turn early is now cheap, because a reply the caller talks past is held and folded into the next. Ending one late is dead air every time.
