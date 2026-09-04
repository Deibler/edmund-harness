import { z } from "zod";
import { dispatchOrRun } from "../../background/dispatch.ts";
import { SsrfBlockedError, webFetch } from "../../web/fetch.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 5;

const SearchInput = z.object({
  query: z.string().describe("Search query."),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe(
      `Number of results to return (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}).`,
    ),
});

const FetchInput = z.object({
  url: z.string().describe("HTTP or HTTPS URL to fetch."),
  mode: z
    .enum(["markdown", "text"])
    .optional()
    .describe(
      'Extraction mode: "markdown" (default) preserves headers/links/code; "text" returns plain prose.',
    ),
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .optional()
    .describe("Maximum characters to return (default 40,000)."),
  async: z
    .boolean()
    .optional()
    .describe(
      "Run in background. Most pages fetch in 1-5s so inline is usually fine, but pass true for pages that might be slow (JS-heavy sites, rate-limited APIs).",
    ),
});

type BraveResult = {
  title: string;
  url: string;
  description?: string;
};

type BraveResponse = {
  web?: {
    results?: BraveResult[];
  };
};

export function webTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "web_search",
      description:
        "Search the web using Brave Search. Returns titles, URLs, and short descriptions. Follow up with web_fetch to read the full content of any result.",
      inputSchema: SearchInput,
      handler: async (args) => {
        const apiKey = ctx.config.keys.brave;
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "web_search is not configured: no Brave API key in config.keys.brave",
              },
            ],
            isError: true,
          };
        }

        const count = args.count ?? DEFAULT_SEARCH_RESULTS;
        const params = new URLSearchParams({ q: args.query, count: String(count) });
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
          },
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Brave Search API error: ${response.status} ${response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as BraveResponse;
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No results for: ${args.query}` }] };
        }

        const lines = results.map((r, i) => {
          const desc = r.description ? `\n   ${r.description}` : "";
          return `${i + 1}. ${r.title}\n   ${r.url}${desc}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Search results for "${args.query}":\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      },
    },
    {
      name: "web_fetch",
      description:
        "Fetch a URL and return its content as readable text or markdown. Automatically strips navigation, scripts, and other non-content elements. Use after web_search to read full articles, docs, or pages. Pass async:true for slow pages or when chaining multiple fetches.",
      inputSchema: FetchInput,
      handler: async (args) => {
        if (args.async === true) {
          return dispatchOrRun("web_fetch", args as Record<string, unknown>, ctx);
        }
        try {
          const result = await webFetch(args.url, {
            mode: args.mode ?? "markdown",
            maxChars: args.max_chars,
          });

          const header = result.title
            ? `# ${result.title}\n${result.url}\n\n`
            : `${result.url}\n\n`;
          const truncatedNote = result.truncated
            ? "\n\n[Content truncated — use max_chars to increase limit]"
            : "";

          return {
            content: [
              {
                type: "text",
                text: `${header}${result.content}${truncatedNote}`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isBlocked = err instanceof SsrfBlockedError;
          return {
            content: [
              {
                type: "text",
                text: isBlocked ? `Blocked: ${msg}` : `Fetch failed: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
  ];
}
