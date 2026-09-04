---
name: history
description: Research past messages and shared files in the current iMessage conversation.
---

# history

The edmund-harness MCP server exposes three read-only tools scoped to the current conversation (group chat, or DM contact including any aliased handles):

## When to use

- User references something "earlier," "yesterday," "that photo," "what I said about X"
- You need to ground a reply in concrete prior context (not just your working memory)
- A group question needs specific recall ("who suggested Friday?")
- User sends a follow-up about a file or image they shared previously

## Tools

### `search_history(query?, sender?, since?, until?, limit?)`
Substring search + metadata filters. Returns `msg_guid  ISO-time  Sender: text`. Use a tight `limit` (default 50) to keep results readable.

```
search_history(query="Friday plans")
search_history(sender="+15550100001", since="2026-04-15")
search_history(since="2026-04-18T00:00:00Z", limit=30)
```

### `get_message(msg_guid)`
Full text + attachment paths for a single message from the search results. Use when the preview was truncated or you need attachment paths.

### `list_attachments(mime_prefix?, since?, sender?, limit?)`
List images/audio/files shared in this chat. Returns absolute paths. Pair with the built-in `Read` tool to actually view an image.

```
list_attachments(mime_prefix="image/", limit=20)
list_attachments(since="2026-04-01")
```

## Patterns

**User: "pull up the photo riley sent last week"**
1. `list_attachments(mime_prefix="image/", sender="<riley's handle>", since="<7 days ago>")`
2. `Read` the file path
3. Reply based on what you saw

**User: "what did jordan say about the api?"**
1. `search_history(query="api", sender="+15550100001", limit=10)`
2. Summarize the hits in the reply

**Don't over-fetch.** If your working memory (from `--resume`) already has the answer, skip the tool. Only search when you're missing context.
