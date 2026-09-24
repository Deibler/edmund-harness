---
"edmund-harness": patch
---

Fix a scheduled note sync that could not remove a stale line. Key presses in Notes and Messages now go to the window that holds the focused element. With several checklist lines selected, Notes puts a small untitled window in front of the note, and every key was refused with "did not say which note is open". A Delete or forward-delete is now described to the safety check by the text it removes, read from the accessibility tree, and typing over a selection by what it replaces. The destructive question now says that deleting a line a scheduled event's list no longer has is the requested edit. The scheduled event is passed to the check whole (up to 4,000 characters instead of 800). Replayed against the refused forward-delete, the check allows it: destructive 0.29 to 0.38, down from 0.74.
