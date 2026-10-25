import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SsrfBlockedError, assertPublicUrl } from "./ssrf.ts";

const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/**
 * fetch() with the SSRF guard applied to EVERY hop, not just the first URL.
 * `redirect: "follow"` validates the address the model asked for and then
 * happily follows a 302 to 127.0.0.1 or the metadata service. This follows
 * redirects by hand, re-checking each Location, refusing non-http schemes,
 * and dropping credential headers when the origin changes.
 */
export async function guardedFetch(
  input: URL | string,
  init: Omit<RequestInit, "redirect"> & { headers?: Record<string, string> } = {},
  opts: { maxRedirects?: number } = {},
): Promise<Response> {
  const max = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = typeof input === "string" ? new URL(input) : input;
  let headers: Record<string, string> = { ...(init.headers ?? {}) };
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme: ${current.protocol}`);
    }
    await assertPublicUrl(current);
    const res = await fetch(current.toString(), { ...init, headers, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hop >= max) throw new Error(`Too many redirects (more than ${max})`);
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      const stripped: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!/^(authorization|cookie|proxy-authorization)$/i.test(k)) stripped[k] = v;
      }
      headers = stripped;
    }
    current = next;
  }
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type FetchResult = {
  url: string;
  title: string | null;
  content: string;
  truncated: boolean;
  /** True when the page came from the headless-browser fallback. */
  viaBrowser?: boolean;
};

/**
 * The page could not be read: a bot wall, a login wall, an error page. Its
 * message says what was tried. Distinct from other failures so the tool can
 * tell the model plainly that it has NOT seen the page: in 90 days, 19
 * requests hit a blocked site, and at least one answer ($449 headlights
 * "plug right in") was built from the listing title instead.
 */
export class UnreadablePageError extends Error {}

/** Statuses a site uses to turn away a non-browser client. */
const BLOCK_STATUSES = new Set([401, 403, 406, 429, 451, 503]);

/** A page whose title says it is a wall rather than the content. */
const BLOCK_TITLE =
  /\b(blocked|access denied|just a moment|attention required|are you a robot|captcha|security check|unusual traffic|error page|pardon our interruption|request rejected)\b/i;

export function looksBlocked(title: string | null, text: string): boolean {
  if (title && BLOCK_TITLE.test(title)) return true;
  return (
    text.length < 2_000 &&
    /\b(enable javascript and cookies|verify you are (a )?human|access to this page has been denied)\b/i.test(
      text,
    )
  );
}

const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Render a page in headless Chrome (a fresh throwaway profile) and return
 * its DOM, or null when Chrome is missing, times out or returns nothing.
 * Many sites that refuse a plain fetch serve a real browser (measured
 * 2026-10-25: a retailer's search page, 403 to fetch, rendered in full);
 * sites with stronger bot detection still refuse it, and then the page is
 * reported unreadable rather than guessed at.
 */
export async function renderInBrowser(
  url: string,
  opts: { timeoutMs?: number; chromeBin?: string } = {},
): Promise<string | null> {
  const bin = opts.chromeBin ?? CHROME_BIN;
  if (!existsSync(bin)) return null;
  const profile = mkdtempSync(join(tmpdir(), "edmund-headless-"));
  try {
    return await new Promise<string | null>((resolve) => {
      const proc = spawn(
        bin,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profile}`,
          "--virtual-time-budget=8000",
          "--dump-dom",
          url,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let out = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(null);
      }, opts.timeoutMs ?? 30_000);
      proc.stdout.on("data", (c) => {
        if (out.length < DEFAULT_MAX_BYTES * 2) out += c.toString();
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      proc.on("close", () => {
        clearTimeout(timer);
        resolve(out.trim() ? out : null);
      });
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

type FetchError = {
  url: string;
  error: string;
  blocked?: boolean;
};

export async function webFetch(
  urlStr: string,
  opts: {
    maxChars?: number;
    mode?: "markdown" | "text";
    timeoutMs?: number;
    maxBytes?: number;
    /** Retry a blocked page in headless Chrome. Default on. */
    browserFallback?: boolean;
  } = {},
): Promise<FetchResult> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const mode = opts.mode ?? "markdown";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await guardedFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Fetch timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (BLOCK_STATUSES.has(response.status) && opts.browserFallback !== false) {
      return fromBrowser(urlStr, `HTTP ${response.status}`, mode, maxChars);
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.includes("html") &&
    !contentType.includes("text") &&
    !contentType.includes("xml")
  ) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  // Stream body up to maxBytes
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is empty");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncatedAtByte = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (totalBytes - maxBytes)));
      truncatedAtByte = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }

  const html = new TextDecoder().decode(concatUint8Arrays(chunks));
  const finalUrl = response.url || urlStr;
  const title = extractTitle(html);

  const content = mode === "text" ? htmlToText(html) : htmlToMarkdown(html);
  if (looksBlocked(title, content)) {
    if (opts.browserFallback === false) {
      throw new UnreadablePageError(`the site served a block page ("${title ?? "untitled"}")`);
    }
    return fromBrowser(urlStr, `a block page ("${title ?? "untitled"}")`, mode, maxChars);
  }
  const truncated = truncatedAtByte || content.length > maxChars;

  return {
    url: finalUrl,
    title,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
  };
}

async function fromBrowser(
  url: string,
  firstFailure: string,
  mode: "markdown" | "text",
  maxChars: number,
): Promise<FetchResult> {
  const html = await renderInBrowser(url);
  if (!html) {
    throw new UnreadablePageError(`${firstFailure}, and a headless browser got nothing back`);
  }
  const title = extractTitle(html);
  const content = mode === "text" ? htmlToText(html) : htmlToMarkdown(html);
  if (looksBlocked(title, content)) {
    throw new UnreadablePageError(
      `${firstFailure}, and a headless browser was refused too ("${title ?? "untitled"}")`,
    );
  }
  const truncated = content.length > maxChars;
  return {
    url,
    title,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    viaBrowser: true,
  };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return null;
  return decodeEntities(m[1]).replace(/\s+/g, " ").trim() || null;
}

function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove invisible/non-content blocks
  text = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gis, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gis, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gis, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Headings
  for (let i = 1; i <= 6; i++) {
    const hashes = "#".repeat(i);
    text = text.replace(
      new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi"),
      (_, inner) => `\n\n${hashes} ${stripTags(inner).trim()}\n\n`,
    );
  }

  // Links
  text = text.replace(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const linkText = stripTags(inner).trim();
    if (!linkText) return href;
    if (!href || href === "#" || href.startsWith("javascript:")) return linkText;
    return `[${linkText}](${href})`;
  });

  // Bold / italic
  text = text.replace(
    /<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    (_, c) => `**${stripTags(c).trim()}**`,
  );
  text = text.replace(
    /<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
    (_, c) => `*${stripTags(c).trim()}*`,
  );

  // Code
  text = text.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, c) => `\n\`\`\`\n${decodeEntities(stripTags(c))}\n\`\`\`\n`,
  );
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${stripTags(c)}\``);

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${stripTags(c).trim()}`);

  // Block elements → newlines
  text = text.replace(
    /<(?:p|div|section|article|main|header|blockquote|tr|br\s*\/?)( [^>]*)?\/?>/gi,
    "\n",
  );
  text = text.replace(
    /<\/(?:p|div|section|article|main|blockquote|ul|ol|table|thead|tbody|tr)>/gi,
    "\n",
  );

  text = stripTags(text);
  text = decodeEntities(text);
  return normalizeWhitespace(text);
}

function htmlToText(html: string): string {
  let text = html;
  text = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n");
  text = stripTags(text);
  text = decodeEntities(text);
  return normalizeWhitespace(text);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)));
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/[ ]\n/g, "\n")
    .replace(/\n[ ]/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export { SsrfBlockedError };
