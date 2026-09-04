---
name: cloudflare
description: Headless browser automation via Cloudflare Browser Run — screenshot pages, render PDFs, extract markdown/HTML/links, scrape DOM elements with CSS selectors, or AI-extract structured JSON. Runs real Chrome on Cloudflare's global network; handles JavaScript-heavy SPAs. All outputs are saved to the sandbox under cloudflare/<type>/.
---

# cloudflare — Browser Run

Run real Chrome on Cloudflare's global network. No Puppeteer setup, no headless browser to manage. One tool call, one output file.

## Tool reference

| Tool | What it does | Output dir |
|------|-------------|------------|
| `cf_screenshot` | Full-page or viewport screenshot (PNG) | `cloudflare/screenshot/` |
| `cf_pdf` | Render page or HTML as PDF | `cloudflare/pdf/` |
| `cf_markdown` | Extract clean Markdown (strips nav, ads, scripts) | `cloudflare/markdown/` |
| `cf_content` | Full rendered HTML after JS execution | `cloudflare/content/` |
| `cf_snapshot` | Screenshot + HTML in one call | `cloudflare/screenshot/` + `cloudflare/html/` |
| `cf_links` | All links (or visible-only / same-domain) | `cloudflare/json/` |
| `cf_scrape` | DOM element data by CSS selector | `cloudflare/json/` |
| `cf_json` | AI-powered structured data extraction | `cloudflare/json/` |

All files are saved with a `<timestamp>-<url-slug>.<ext>` filename inside the sandbox.

## async: true — works for ALL slow tools

The `async: true` pattern is generic across the harness. It works for:

- All `cf_*` tools (screenshot, pdf, markdown, content, snapshot, links, scrape, json)
- `generate_image`, `generate_video`, `generate_audio`
- `transcribe_audio` (for long audio)
- `web_fetch` (for slow / large fetches)

Whenever a tool is slow enough to make the user wait, pass `async: true`. Same mechanic everywhere: detached worker, cron wake-up, result in the envelope.

## ⚠️ Always pass `async: true`

**Every CF tool takes 15-90 seconds.** Calling them synchronously holds the session lock — the user gets zero responses until the tool returns. Never do this.

Every CF tool accepts `async: true`. When set, the tool:
1. Spawns a detached worker process that makes the actual API call
2. Returns immediately with a background job id (session lock releases instantly)
3. Saves the output to the sandbox as the worker completes
4. Fires an automatic wake-up event in this session once done — you get invoked again with the result path in the envelope

The correct pattern:

```
user: "screenshot example.com"
edmund: send_message("on it, give me a sec")
        cf_screenshot({ url: "https://example.com", full_page: true, async: true })
          → "Background job started: bg_xyz123. ... End your turn now."
        [TURN ENDS]  ← session lock released, user can keep messaging

[worker runs, saves PNG, fires wake-up cron]

edmund wakes up with event:
        "Background tool job finished (status: done). ... Saved: /path/to/screenshot.png"
edmund: send_attachment("/path/to/screenshot.png", "here you go")
```

Never do this:
```
edmund: cf_screenshot({ url: "...", full_page: true })   ← NO async:true, blocks session 30-90s
```

**Rule:** if in doubt, pass `async: true`. Inline sync mode is only for rare cases where you need the result within the same turn (e.g., you're already mid-chain and need the data to continue a calculation). For user-facing "fetch/capture/extract X", it's always async.

## `check_bg_job` / `list_bg_jobs`

You usually don't need these — completed background jobs wake you up automatically with the result included. But:
- `list_bg_jobs` — see what's currently running ("what are you working on?")
- `check_bg_job(id)` — inspect a specific job's status

## When to use which tool

**Reading an article or doc?** → `cf_markdown`. Returns the content inline + saves to disk. Cheapest and fastest.

**Need the visual?** → `cf_screenshot`. Returns path only — follow up with `send_attachment(path)` to share.

**Generating a report or invoice from HTML?** → `cf_pdf`. Always use `send_attachment(path)` to share.

**JS-heavy page (SPA, React, Vue)?** → add `wait_until: "networkidle0"` to any tool. This waits for all network activity to settle before capturing.

**Full DOM including dynamically injected elements?** → `cf_content`. Saves rendered HTML; use the Read tool to inspect it.

**Both screenshot and HTML at once?** → `cf_snapshot`. Single API call, two output files.

**Site mapping, crawl seeding, link auditing?** → `cf_links`. Use `visible_only: true` to skip hidden/footer links; `exclude_external: true` to stay on-domain.

**Scraping specific data fields?** → `cf_scrape` with CSS selectors for precise extraction without AI overhead.

**Structured data in a known shape?** → `cf_json` with a `schema`. For less structured extraction, use `prompt` alone.

## Delivery

All tools return the **local sandbox path** of the saved file. To share with the user:

- **Images / screenshots**: `send_attachment(path)` — iMessage delivers inline.
- **PDFs**: `send_attachment(path)` — iMessage delivers as downloadable.
- **Markdown**: already returned inline, no attachment needed for short content.
- **JSON / HTML**: if the user wants to see it, `send_attachment(path)` or summarize inline.

**Never** just print the path and say "here's the file" — the user can't see your filesystem.

## JavaScript-heavy pages

If you get empty or incomplete results, add `wait_until: "networkidle0"`:

```
cf_markdown({ url: "https://app.example.com/dashboard", wait_until: "networkidle0" })
```

For very slow pages, try `"networkidle2"` (waits for ≤2 open connections instead of 0).

## Sending a screenshot example

```
1. cf_screenshot({ url: "https://example.com", full_page: true })
   → saved to /sandbox/cloudflare/screenshot/2026-04-20T12-30-00-example-com.png

2. send_attachment("/sandbox/cloudflare/screenshot/2026-04-20T12-30-00-example-com.png",
                   "here's the screenshot")
```

## AI JSON extraction example

Extract product info:
```
cf_json({
  url: "https://store.example.com/product/123",
  prompt: "Get the product name, price, availability status, and SKU",
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      price: { type: "number" },
      available: { type: "boolean" },
      sku: { type: "string" }
    }
  }
})
```

Extract with prompt only (less structured):
```
cf_json({
  url: "https://news.ycombinator.com",
  prompt: "Get the top 5 story titles and their point counts"
})
```

## CSS scraping example

```
cf_scrape({
  url: "https://news.ycombinator.com",
  selectors: [".titleline > a", ".score"]
})
```

Returns text, HTML, and attributes for each matching element.

## Sub-agent usage

Sub-agents have the same tool palette. When an agent calls `cf_screenshot`, `cf_pdf`, etc., the output goes into **the agent's own sandbox** (`<parent-sandbox>/agents/<id>/cloudflare/<type>/`).

To run browser capture in the background and surface the result:

```
spawn_agent(task: "Screenshot https://example.com full-page and return the file path")
```

The agent calls `cf_screenshot`, writes the result, and returns the path in its final text. You then `read_agent_result(id)` and `send_attachment(path)`.

## Output cleanup

Files accumulate in `cloudflare/` over time. To clean up stale captures:
```bash
ls cloudflare/screenshot/    # see what's there
rm cloudflare/screenshot/2026-04-18*   # remove specific date
```

Keep organized — don't let the directory grow unbounded across long sessions.
