---
"edmund-harness": patch
---

Fix contacts' screenshots showing other people's conversations. On macOS 26 a capture that includes only some apps covered just the box around their windows, stretched to fill the image, so the black-outs (placed at the windows' real positions) missed: a test capture as a contact showed every other conversation in the Messages sidebar. The capture now always covers the whole display. A live test (`EDMUND_LIVE_SCREEN=1`) compares a contact's capture with the owner's and fails if the window moves.
