/**
 * What the model opened on the web, from the tool calls it made.
 *
 * The model browses in three ways and the harness sees the request for each:
 * the CLI's own fetch and search tools, the browser it drives through
 * chrome-devtools, and a URL inside a shell command. None of those requests
 * leave from this process, so the `net-out` hook cannot see them; the tool
 * call is the record. One `browse` record each, with the conversation.
 *
 * A URL keeps its query, because for a page the query is often the page, with
 * the values of parameters that look like credentials hidden.
 */
import { safePath } from "./log-instrument.ts";
import { log } from "./log.ts";

export type BrowseEvent = { kind: "fetch" | "search" | "browser" | "shell"; target: string };

const SECRET_PARAM = /(key|token|secret|sig|signature|auth|password|passwd|code|session)/i;

/** A URL fit for a log: origin, path, and the query with secret-looking values hidden. */
export function loggableUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const params: string[] = [];
  for (const [name, value] of url.searchParams) {
    const shown = SECRET_PARAM.test(name)
      ? "***"
      : value.length > 80
        ? `${value.slice(0, 80)}…`
        : value;
    params.push(`${name}=${shown}`);
  }
  return `${url.origin}${safePath(url.pathname)}${params.length ? `?${params.join("&")}` : ""}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The browse events one tool call amounts to; none for a tool that does not
 * touch the web. `name` is as the model called it (`WebFetch`,
 * `mcp__chrome-devtools__navigate_page`, `Bash`).
 */
export function browseEventsFor(name: string | undefined, input: unknown): BrowseEvent[] {
  if (!name) return [];
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const base = name.split("__").pop() ?? name;
  const lower = base.toLowerCase();
  const url = text(args.url) ?? text(args.uri) ?? text(args.link);
  const query = text(args.query) ?? text(args.q);

  if (name === "Bash" || lower === "shell" || lower === "exec_command") {
    const command = text(args.command) ?? text(args.cmd) ?? "";
    const seen = new Set<string>();
    for (const m of command.matchAll(/https?:\/\/[^\s"'`<>)\\]+/g)) {
      const shown = loggableUrl(m[0]);
      if (shown) seen.add(shown);
      if (seen.size >= 5) break;
    }
    return [...seen].map((target) => ({ kind: "shell" as const, target }));
  }
  if (name.includes("chrome-devtools") || name.includes("chrome_devtools")) {
    const shown = url ? loggableUrl(url) : null;
    return [{ kind: "browser", target: shown ? `${base} ${shown}` : base }];
  }
  if (/search/.test(lower) && query) return [{ kind: "search", target: query.slice(0, 300) }];
  if (/(fetch|browse|navigate|open_url|read_url|web)/.test(lower) && url) {
    const shown = loggableUrl(url);
    return shown ? [{ kind: "fetch", target: shown }] : [];
  }
  return [];
}

/** Record what a tool call opened on the web, if anything. */
export function recordBrowse(session: string, name: string | undefined, input: unknown): void {
  for (const event of browseEventsFor(name, input)) {
    log.event("browse", "browse", `${event.kind} ${event.target}`, {
      session,
      kind: event.kind,
      tool: name,
      target: event.target,
    });
  }
}
