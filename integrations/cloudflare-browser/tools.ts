import { z } from "zod";
import { dispatchOrRun } from "../../src/background/dispatch.ts";
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";

// Every tool gets these:
const asyncField = z
  .boolean()
  .optional()
  .describe(
    "Run in background (recommended). When true, this call returns immediately with a job id and the session lock releases — the user can keep messaging. When the job completes, a wake-up event fires and you deliver the result then. ALWAYS use true unless you have a specific reason to block.",
  );

const waitUntilField = z
  .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
  .optional()
  .describe(
    'When to consider page loaded. Use "networkidle0" for JS-heavy SPAs, "domcontentloaded" for speed.',
  );

// ─── tool defs ───────────────────────────────────────────────────────────────

export function cloudflareBrowserTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "cf_screenshot",
      description:
        "Capture a screenshot of a URL or HTML using Cloudflare's headless browser. Saves PNG to cloudflare/screenshot/ in the sandbox. Takes 15-90s — ALWAYS pass async:true so this backgrounds and the session stays responsive. You'll be woken up when the PNG is ready; then send_attachment(path).",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to capture. Provide url OR html."),
        html: z.string().optional().describe("Raw HTML to render and capture."),
        full_page: z
          .boolean()
          .optional()
          .describe("Capture the full scrollable page (default: viewport only)."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector — capture only that element instead of the full viewport."),
        viewport_width: z.number().int().optional().describe("Viewport width px (default 1920)."),
        viewport_height: z.number().int().optional().describe("Viewport height px (default 1080)."),
        wait_until: waitUntilField,
        wait_timeout_ms: z
          .number()
          .int()
          .optional()
          .describe("Max ms to wait for load (default 30000)."),
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_screenshot", args, ctx),
    },
    {
      name: "cf_pdf",
      description:
        "Render a webpage or HTML as PDF. Saves to cloudflare/pdf/. Takes 15-90s — ALWAYS pass async:true. You'll wake when the PDF is ready; then send_attachment(path).",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to render as PDF."),
        html: z.string().optional().describe("Raw HTML to render as PDF."),
        format: z
          .enum(["letter", "legal", "a4", "a3", "a5"])
          .optional()
          .describe("Paper format (default: letter)."),
        landscape: z.boolean().optional().describe("Landscape orientation."),
        print_background: z.boolean().optional().describe("Include background colors/images."),
        wait_until: waitUntilField,
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_pdf", args, ctx),
    },
    {
      name: "cf_markdown",
      description:
        "Extract clean Markdown from a webpage (handles JS, strips nav/ads). Saves to cloudflare/markdown/. Takes 15-60s — ALWAYS pass async:true. You'll wake with the markdown text; relay inline to the user.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to extract markdown from."),
        html: z.string().optional().describe("Raw HTML to convert to markdown."),
        wait_until: waitUntilField,
        reject_css: z.boolean().optional().describe("Block CSS for cleaner/faster extraction."),
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_markdown", args, ctx),
    },
    {
      name: "cf_content",
      description:
        "Fetch fully rendered HTML (post-JS). Saves to cloudflare/content/. Takes 15-60s — ALWAYS pass async:true. Use when you need the complete DOM including dynamic elements.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to fetch rendered HTML from."),
        html: z.string().optional().describe("Raw HTML to render and return."),
        wait_until: waitUntilField,
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_content", args, ctx),
    },
    {
      name: "cf_snapshot",
      description:
        "Capture HTML + screenshot in one call. Saves to cloudflare/screenshot/ and cloudflare/html/. Takes 30-90s — ALWAYS pass async:true. You'll wake with both paths; send_attachment the screenshot.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to snapshot."),
        html: z.string().optional().describe("Raw HTML to snapshot."),
        full_page: z.boolean().optional().describe("Full-page screenshot."),
        wait_until: waitUntilField,
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_snapshot", args, ctx),
    },
    {
      name: "cf_links",
      description:
        "Extract all links from a webpage (post-JS). Saves JSON to cloudflare/json/. Takes 15-60s — ALWAYS pass async:true. Use for site mapping, crawling, link audits.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to extract links from."),
        html: z.string().optional().describe("Raw HTML to extract links from."),
        visible_only: z.boolean().optional().describe("Only visible links."),
        exclude_external: z.boolean().optional().describe("Exclude other-domain links."),
        wait_until: waitUntilField,
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_links", args, ctx),
    },
    {
      name: "cf_scrape",
      description:
        "Scrape DOM elements by CSS selector (text, HTML, attributes). Saves to cloudflare/json/. Takes 15-60s — ALWAYS pass async:true.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to scrape."),
        html: z.string().optional().describe("Raw HTML to scrape."),
        selectors: z
          .array(z.string())
          .min(1)
          .describe('CSS selectors, e.g. ["h1", ".price", "#main article"].'),
        wait_until: waitUntilField,
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_scrape", args, ctx),
    },
    {
      name: "cf_json",
      description:
        "AI-powered structured JSON extraction. Pass a prompt and optional JSON schema. Saves to cloudflare/json/. Takes 20-90s — ALWAYS pass async:true.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to extract data from."),
        html: z.string().optional().describe("Raw HTML to extract data from."),
        prompt: z.string().optional().describe("What to extract in natural language."),
        schema: z.record(z.unknown()).optional().describe("JSON Schema for typed output."),
        wait_until: waitUntilField,
        async: asyncField,
      }),
      handler: (args) => dispatchOrRun("cf_json", args, ctx),
    },
  ];
}
