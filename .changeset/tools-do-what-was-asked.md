---
"edmund-harness": patch
---

A tool call does what the model asked or says that it did not, and the thread a compaction puts back ends with the newest message.

- **Reactions.** `react` refuses a word that is not a reaction (`love`, `like`, `dislike`, `laugh`, `emphasis`, `question`, or one emoji) before anything is sent. A word it did not know used to go out as an emoji reaction whose emoji was the word, which no phone could show. Its answer now names the message the reaction landed on, and "the newest message" is never somebody's own tapback.
- **Misnamed arguments.** A call that names an argument its tool does not have is refused before the tool runs, with the names the tool takes. Such an argument used to be dropped without a word, so an optional one that was misnamed changed what the tool did: a reaction meant for one message went to another. Two names seen often in the log are read as the argument they meant (`target_msg_guid`, `agent_id`).
- **What the model is told.** The tool list in the system prompt named arguments four tools do not have (`react`, `message_contact`, `generate_audio`, `generate_video`), and two skills did the same. They are corrected, and a test now holds every written signature to the tool's schema.
- **Replying to a message by its id.** `send_message(reply_to)` takes the message id a mid-turn note shows, as that note has always said to, and only for a message in the same conversation. It took a snippet of text only.
- **After a compaction.** The hook that puts the latest messages back wrote up to 12,000 characters, and Claude Code keeps 10,000 of a hook's output, cutting the end: the newest messages. It now fits what is kept and gives way from the old end.
- **Service commands.** `edmund start`, `stop`, `restart`, `status` and `kill` print their usage for `--help` and refuse a flag or word they do not take. `edmund restart --help` used to restart every service.
