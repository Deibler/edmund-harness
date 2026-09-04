import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Cloudflare from "cloudflare";
import type {
  ContentCreateParams,
  JsonCreateParams,
  LinkCreateParams,
  MarkdownCreateParams,
  PDFCreateParams,
  ScrapeCreateParams,
  ScreenshotCreateParams,
  SnapshotCreateParams,
} from "cloudflare/resources/browser-rendering/index.js";

/**
 * Core Cloudflare Browser Run execution — used by both the inline MCP
 * tool handlers (src/mcp/tools/cloudflare-browser.ts) and the background
 * runner (scripts/cf-bg-runner.ts). Pure functions: no ToolContext
 * dependency, just (args, sandboxPath, client, accountId).
 */

// 90s SDK-level timeout — generous for slow SPA renders, but caps hangs.
const CF_TIMEOUT_MS = 90_000;

type CfToolName =
  | "cf_screenshot"
  | "cf_pdf"
  | "cf_markdown"
  | "cf_content"
  | "cf_snapshot"
  | "cf_links"
  | "cf_scrape"
  | "cf_json";

export type CfExecResult = {
  /** Path(s) written to the sandbox. Primary path goes in summary too. */
  resultPath: string;
  /** Short human-readable summary that goes to the model. */
  summary: string;
};

export function makeCfClient(apiToken: string): Cloudflare {
  return new Cloudflare({ apiToken, timeout: CF_TIMEOUT_MS });
}

function slugifyUrl(urlOrHtml: string | undefined): string {
  if (!urlOrHtml) return "html";
  if (urlOrHtml.length > 200 || urlOrHtml.trimStart().startsWith("<")) return "html";
  try {
    const u = new URL(urlOrHtml);
    return (
      (u.hostname + u.pathname)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "page"
    );
  } catch {
    return "page";
  }
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function outPath(sandboxPath: string, subdir: string, name: string): string {
  const dir = join(sandboxPath, "cloudflare", subdir);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

// ─── per-tool executors ──────────────────────────────────────────────────────

export async function execCfScreenshot(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: ScreenshotCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    ...(args.selector ? { selector: args.selector as string } : {}),
    screenshotOptions: { fullPage: (args.full_page as boolean) ?? false },
    viewport:
      args.viewport_width || args.viewport_height
        ? {
            width: (args.viewport_width as number) ?? 1920,
            height: (args.viewport_height as number) ?? 1080,
          }
        : undefined,
    gotoOptions:
      args.wait_until || args.wait_timeout_ms
        ? {
            waitUntil: args.wait_until as ScreenshotCreateParams.GotoOptions["waitUntil"],
            timeout: args.wait_timeout_ms as number | undefined,
          }
        : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "screenshot", `${ts()}-${slug}.png`);
  const rawResp = await client.browserRendering.screenshot.create(params).asResponse();
  if (!rawResp.ok) throw new Error(`HTTP ${rawResp.status}: ${rawResp.statusText}`);
  const buf = Buffer.from(await rawResp.arrayBuffer());
  writeFileSync(path, buf);
  return {
    resultPath: path,
    summary: `Screenshot saved: ${path}\nSize: ${buf.length} bytes\nSend with send_attachment("${path}") to share it.`,
  };
}

export async function execCfPdf(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: PDFCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    pdfOptions: {
      format: args.format as PDFCreateParams.PDFOptions["format"],
      landscape: args.landscape as boolean | undefined,
      printBackground: args.print_background as boolean | undefined,
    },
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as PDFCreateParams.GotoOptions["waitUntil"] }
      : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "pdf", `${ts()}-${slug}.pdf`);
  const pdfResponse = await client.browserRendering.pdf.create(params);
  const buf = Buffer.from(await pdfResponse.arrayBuffer());
  writeFileSync(path, buf);
  return {
    resultPath: path,
    summary: `PDF saved: ${path}\nSize: ${buf.length} bytes\nSend with send_attachment("${path}") to share it.`,
  };
}

export async function execCfMarkdown(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: MarkdownCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as MarkdownCreateParams.GotoOptions["waitUntil"] }
      : undefined,
    rejectRequestPattern: args.reject_css ? ["/^.*\\.(css)"] : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "markdown", `${ts()}-${slug}.md`);
  const markdown = await client.browserRendering.markdown.create(params);
  writeFileSync(path, markdown);
  const preview =
    markdown.length > 2000
      ? `${markdown.slice(0, 2000)}\n\n[... truncated, full content at ${path}]`
      : markdown;
  return {
    resultPath: path,
    summary: `Saved to: ${path}\n\n---\n\n${preview}`,
  };
}

export async function execCfContent(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: ContentCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as ContentCreateParams.GotoOptions["waitUntil"] }
      : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "content", `${ts()}-${slug}.html`);
  const content = await client.browserRendering.content.create(params);
  writeFileSync(path, content);
  return {
    resultPath: path,
    summary: `Rendered HTML saved: ${path}\nSize: ${content.length} chars\nRead it with the Read tool.`,
  };
}

export async function execCfSnapshot(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: SnapshotCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    screenshotOptions: { fullPage: (args.full_page as boolean) ?? false },
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as SnapshotCreateParams.GotoOptions["waitUntil"] }
      : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const prefix = `${ts()}-${slug}`;
  const screenshotPath = outPath(sandboxPath, "screenshot", `${prefix}.png`);
  const htmlPath = outPath(sandboxPath, "html", `${prefix}.html`);
  const snap = await client.browserRendering.snapshot.create(params);
  // Both fields are optional in the API: a render that fails part way returns
  // the half it managed. Writing an empty file would hand the model a
  // screenshot path that opens to nothing, so say what is missing instead.
  if (snap.screenshot === undefined || snap.content === undefined) {
    const missing = [
      snap.screenshot === undefined ? "screenshot" : null,
      snap.content === undefined ? "html content" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    throw new Error(`Cloudflare returned a snapshot with no ${missing}`);
  }
  writeFileSync(screenshotPath, Buffer.from(snap.screenshot, "base64"));
  writeFileSync(htmlPath, snap.content);
  return {
    resultPath: screenshotPath,
    summary: [
      `Snapshot saved:`,
      `  Screenshot: ${screenshotPath}`,
      `  HTML: ${htmlPath}`,
      `Send screenshot with send_attachment("${screenshotPath}").`,
    ].join("\n"),
  };
}

export async function execCfLinks(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: LinkCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    visibleLinksOnly: args.visible_only as boolean | undefined,
    excludeExternalLinks: args.exclude_external as boolean | undefined,
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as LinkCreateParams.GotoOptions["waitUntil"] }
      : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "json", `${ts()}-${slug}-links.json`);
  const links = await client.browserRendering.links.create(params);
  writeFileSync(path, JSON.stringify(links, null, 2));
  const preview = links.slice(0, 30).join("\n");
  const note = links.length > 30 ? `\n… and ${links.length - 30} more (see ${path})` : "";
  return {
    resultPath: path,
    summary: `Found ${links.length} links. Saved to: ${path}\n\n${preview}${note}`,
  };
}

export async function execCfScrape(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const selectors = args.selectors as string[];
  const params: ScrapeCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    elements: selectors.map((selector) => ({ selector })),
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as ScrapeCreateParams.GotoOptions["waitUntil"] }
      : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "json", `${ts()}-${slug}-scrape.json`);
  const results = await client.browserRendering.scrape.create(params);
  writeFileSync(path, JSON.stringify(results, null, 2));
  const summary = results
    .map((r) => `${r.selector}: ${r.results.text?.slice(0, 100) ?? "(no text)"}`)
    .join("\n");
  return {
    resultPath: path,
    summary: `Scraped ${results.length} selector(s). Saved to: ${path}\n\n${summary}`,
  };
}

export async function execCfJson(
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  const params: JsonCreateParams = {
    account_id: accountId,
    ...(args.url ? { url: args.url as string } : {}),
    ...(args.html ? { html: args.html as string } : {}),
    ...(args.prompt ? { prompt: args.prompt as string } : {}),
    ...(args.schema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: args.schema as Record<
              string,
              string | number | boolean | unknown | string[]
            >,
          },
        }
      : {}),
    gotoOptions: args.wait_until
      ? { waitUntil: args.wait_until as JsonCreateParams.GotoOptions["waitUntil"] }
      : undefined,
  };
  const slug = slugifyUrl((args.url as string) ?? (args.html as string));
  const path = outPath(sandboxPath, "json", `${ts()}-${slug}.json`);
  const result = await client.browserRendering.json.create(params);
  writeFileSync(path, JSON.stringify(result, null, 2));
  const preview = JSON.stringify(result, null, 2);
  const summary =
    preview.length > 2000
      ? `Saved to: ${path}\n\n${preview.slice(0, 2000)}\n[... truncated]`
      : `Saved to: ${path}\n\n${preview}`;
  return { resultPath: path, summary };
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

async function execCfTool(
  toolName: CfToolName,
  args: Record<string, unknown>,
  sandboxPath: string,
  client: Cloudflare,
  accountId: string,
): Promise<CfExecResult> {
  switch (toolName) {
    case "cf_screenshot":
      return execCfScreenshot(args, sandboxPath, client, accountId);
    case "cf_pdf":
      return execCfPdf(args, sandboxPath, client, accountId);
    case "cf_markdown":
      return execCfMarkdown(args, sandboxPath, client, accountId);
    case "cf_content":
      return execCfContent(args, sandboxPath, client, accountId);
    case "cf_snapshot":
      return execCfSnapshot(args, sandboxPath, client, accountId);
    case "cf_links":
      return execCfLinks(args, sandboxPath, client, accountId);
    case "cf_scrape":
      return execCfScrape(args, sandboxPath, client, accountId);
    case "cf_json":
      return execCfJson(args, sandboxPath, client, accountId);
  }
}

function cfErrMsg(err: unknown): string {
  if (err instanceof Cloudflare.APIError) {
    return `Cloudflare API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
