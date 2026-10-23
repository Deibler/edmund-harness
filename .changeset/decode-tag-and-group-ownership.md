---
"edmund-harness": patch
---

Messages of about 42 bytes decode exactly, and group chatter Edmund was never asked about no longer counts as a reply he owes.

- **The decoder no longer reads the type tag as a length.** macOS writes the visible string as `NSString 01 94 84 01 2B <len> <utf8>`. The decoder scans offsets after the marker and keeps the longest valid slice, and the `+` (0x2B) tag is itself a valid one-byte length of 43. Read that way it yields the length byte plus the first 42 bytes of text, which ties a 43-byte message and beats a 42-byte one, and also beats any longer message that trims below 43 characters. The fallback notice read back as "+hit a snag getting back to you, still on i". Candidates whose prefix follows the tag are now preferred; payloads without it keep the old rule. Run over the 50,531 rows of a live chat.db, 842 decode differently, all corrections: 802 had a framing character glued to the front, and 40 short messages ("? ") had been replaced by the attribute token "iI". No row decodes worse.
- **A group row with no routing record is nobody's.** `ownsRow` treated an unrecorded row as owned by the main session, a default meant for old DM rows. In a group, every accepted row is recorded (live path, catch-up, address check), so an unrecorded one is the group talking among themselves. It was fed to recovery turns and counted toward the fallback notice, which sent "hit a snag" into a group nobody had asked anything. Group sessions now require the record; DMs are unchanged.
