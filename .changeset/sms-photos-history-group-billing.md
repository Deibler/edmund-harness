---
"edmund-harness": patch
---

Send and see photos over SMS, stop showing group texts their whole backlog, and send a group reply as one text.

- **Edmund can send files over SMS.**
  - `send_attachment` in a text conversation uploads the file to Twilio's media store and posts it as MMS.
  - Photos are converted to JPEG when the phone might not open them (HEIC, WebP, TIFF), and photos and videos are shrunk to fit MMS's 5 MB limit.
  - Files MMS can't carry (Office docs, zips, web pages) are refused with what to do instead: publish the file and text the link.
  - Nothing needs a public URL; DMs go through the person's own conversation.
- **Photos over SMS were all dropped: 9 of 9 from September to November.**
  - Twilio delivers each photo as its own message with an empty body.
  - The handler checked `NumMedia`, which Twilio's group-text webhook never sends, and returned on the empty body.
  - Photos are now looked up through the official `twilio` SDK, downloaded from Twilio's media service, and handed to the turn as ordinary attachments.
  - A photo that fails to download is named to the model so it can ask for a resend.
- **Group texts now get the same history as iMessage groups:** the active thread, broken at 30 minutes and capped at 30 lines.
  - Before, every turn carried the last 75 messages: about 3,000 tokens, against about 400 for an iMessage group.
  - In one weekly-update group that was two months of Edmund's own "Anytime, <name>. If you only catch one…" replies, which he kept repeating.
  - A cold start is told that earlier threads exist and how to read them back, because recall doesn't index SMS.
- The message being answered no longer also appears in its own history.
- **The SMS channel line now says there are no tapbacks.** Where a tapback would have answered (a thanks, an ok), the guidance is `KEEP_QUIET`, and never to restate what was already sent. 8 of 10 answered acks had restated the previous message.
- The SMS history block no longer offers reactions or reply-threading, which SMS can't do.
- **A group reply is sent as one message,** split only at Twilio's 1,600-character limit.
  - Group texts are MMS, billed flat per recipient whatever the length, so each extra part was another full charge to everyone.
  - That was 28% of measured group text spend.
  - The live group cost estimate now uses the measured per-recipient MMS rate instead of SMS segments.
