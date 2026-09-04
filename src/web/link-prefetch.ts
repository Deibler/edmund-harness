import { SsrfBlockedError, webFetch } from "./fetch.ts";

const URL_PATTERN = /\bhttps?:\/\/(?:[-\w]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"')\]]*)?/gi;

const MAX_URLS = 3;
const PREFETCH_TIMEOUT_MS = 8_000;
const PREFETCH_MAX_CHARS = 8_000;

export type PrefetchEntry = {
  url: string;
  title: string | null;
  snippet: string;
};

function detectUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""); // strip trailing punctuation
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export async function prefetchLinks(texts: string[]): Promise<PrefetchEntry[]> {
  const allUrls: string[] = [];
  for (const t of texts) {
    for (const u of detectUrls(t)) {
      if (!allUrls.includes(u)) allUrls.push(u);
      if (allUrls.length >= MAX_URLS) break;
    }
    if (allUrls.length >= MAX_URLS) break;
  }

  if (allUrls.length === 0) return [];

  const results = await Promise.allSettled(
    allUrls.map((url) =>
      webFetch(url, {
        maxChars: PREFETCH_MAX_CHARS,
        mode: "text",
        timeoutMs: PREFETCH_TIMEOUT_MS,
      }),
    ),
  );

  const entries: PrefetchEntry[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const url = allUrls[i]!;
    if (r.status === "fulfilled") {
      entries.push({
        url,
        title: r.value.title,
        snippet: r.value.content,
      });
    } else {
      const err = r.reason as Error;
      if (!(err instanceof SsrfBlockedError)) {
        // Non-security error: include a short error note so the model knows the fetch failed
        entries.push({ url, title: null, snippet: `[fetch failed: ${err.message}]` });
      }
      // Silently skip SSRF-blocked URLs
    }
  }

  return entries;
}
