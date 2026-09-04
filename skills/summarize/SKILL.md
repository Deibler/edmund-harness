---
name: summarize
description: TL;DR a URL, YouTube video, or local PDF/file via the `summarize` CLI (Gemini Flash). Use when the user sends a link and asks what it's about, drops a YouTube URL and wants the gist, or has a PDF in the sandbox they haven't opened.
---

# summarize

Fast inline answer to "what's this link about?" — no page-opening, no "I can't browse" cop-outs.

## Triggers

- "summarize this", "tl;dr", "what's this about"
- A bare URL followed by any question ("…is this legit?", "worth watching?")
- "transcribe this YouTube / video"
- "what does this PDF say"

## The three modes

### URL / article

```bash
GEMINI_API_KEY="$EDMUND_GEMINI_KEY" \
  summarize "https://..." --length short --json
```

### YouTube

```bash
GEMINI_API_KEY="$EDMUND_GEMINI_KEY" \
  summarize "https://youtu.be/XXXX" --youtube auto --length short --json
```

Add `--extract-only` when the user explicitly asks for a transcript, not a summary. If the transcript is huge, give a summary first and ask which section to expand — don't dump 10k chars into iMessage.

**Latency warning.** YouTube summarization typically runs 30-120s (transcript fetch + Gemini pass). For videos over 20 minutes it can run 2-4 min. Before calling it, if the video looks long, tell the user upfront: "on it — this'll take a minute." That text will flush only at the end of the turn, so the ideal mitigation is just: start summarize promptly, don't layer extra tool calls on top. Keep `--length short` (not `medium` or `long`) as the default.

### Local PDF / file (in the sandbox)

```bash
GEMINI_API_KEY="$EDMUND_GEMINI_KEY" \
  summarize "$EDMUND_SANDBOX_PATH/received-files/thing.pdf" --length short --json
```

Look in `received-files/` and `received-images/` first — that's where inbound attachments land.

## Reply shape (always)

Reformat the model output into:

- 3 bullets (the substance)
- 1 line takeaway ("worth it: yes/no because …", "do this: …", "skip: …")

Keep the whole reply under ~700 chars so it lands in one iMessage chunk. If the source is dense, err toward fewer bullets with sharper wording rather than longer ones.

## Model + auth

- Default uses Gemini Flash via `GEMINI_API_KEY` — the harness exports it as `EDMUND_GEMINI_KEY`, so prepend it to the invocation.
- Don't pass `--model` unless the user asks for a specific one. Flash is fast and cheap for TL;DRs.

## Anti-patterns

- Opening the URL in a browser / web-fetching when `summarize` can just answer. That's slower and drops detail.
- Returning the full `--json` blob. Parse it, reformat to the 3-bullet + takeaway shape.
- Skipping the takeaway line. The bullets are the *what*; the takeaway is the *so what* — that's the part the user actually wanted.
- Summarizing something the user already has context on (a link they shared and already discussed in-thread). Ask before summarizing redundantly.
