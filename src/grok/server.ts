import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { log } from "../util/log.ts";
import {
  type ConnectorBot,
  type GrokAuthMode,
  presentedToken,
  resolveCaller,
  sourceOf,
} from "./auth.ts";
import type { GrokCaller } from "./caller.ts";
import { type ReportOutcome, createConnectorServer } from "./mcp.ts";
import { RateLimiter } from "./rate-limit.ts";

/**
 * The Grok connector's HTTP listener: remote MCP over streamable HTTP, stateless.
 *
 * Loopback only. The way in from outside is a Cloudflare tunnel pointed at this
 * port, so every request here has already crossed the internet and is believed
 * only after it presents the token. Order matters: shut out noisy sources, check
 * the token, then rate limit and parse, so an unauthenticated caller costs a hash
 * and nothing more.
 *
 * Stateless on purpose: every tool is a request/response call, so there is no
 * session to resume, and a tunnel restart or daemon restart cannot strand a
 * client mid-session.
 *
 * A call is answered as plain JSON, except one that carries a progress token:
 * progress notifications can only travel on an event stream, so that call gets
 * one (and the response still ends with the same result).
 */
export type GrokServerOptions = {
  port: number;
  /** The shared key: the car's Grok, and any bot without a key of its own. */
  token: string;
  /** Grok Bots with a connector key of their own. A request that presents one
   *  is that bot, whatever it says about itself. */
  bots?: readonly ConnectorBot[];
  authMode: GrokAuthMode;
  maxMessageChars: number;
  requestsPerMinute: number;
  asksPerMinute: number;
  maxAuthFailures: number;
  /** Longest report_to_edmund result accepted, in characters. */
  maxResultChars?: number;
  /** Seconds between MCP progress notifications while ask waits. */
  progressIntervalMs?: number;
  /** Each callback is told who called, from the key, not from anything the
   *  caller said. */
  ask: (message: string, caller: GrokCaller) => Promise<string>;
  tell: (message: string, caller: GrokCaller) => void;
  check: (caller: GrokCaller) => Promise<string>;
  report: (
    replyId: string,
    result: string,
    caller: GrokCaller,
  ) => Promise<ReportOutcome> | ReportOutcome;
};

/** Longest report_to_edmund result by default. Under the 32 KB body cap. */
const DEFAULT_MAX_RESULT_CHARS = 16_000;

/** A JSON-RPC body for one short message is a few hundred bytes. */
const MAX_BODY_BYTES = 32 * 1024;
/** "/mcp" for a direct tunnel; "/grok/mcp" through the kitchen host's permanent hostname. */
const MCP_PATHS = new Set(["/mcp", "/grok/mcp"]);
const FAILURE_WINDOW_MS = 10 * 60_000;

export function startGrokServer(opts: GrokServerOptions): { stop: () => void; port: number } {
  const failures = new RateLimiter(opts.maxAuthFailures, FAILURE_WINDOW_MS);
  const requests = new RateLimiter(opts.requestsPerMinute, 60_000);
  const asks = new RateLimiter(opts.asksPerMinute, 60_000);
  // A report is a finished job coming home: losing one to the turn limiter costs
  // more than the turn it wakes, and an id Edmund never issued is refused before
  // it costs anything, so it gets a roomier limit of its own.
  const reports = new RateLimiter(Math.max(30, opts.asksPerMinute * 5), 60_000);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    // The slowest legitimate call is the answer timeout plus a turn's tail.
    idleTimeout: 60,
    fetch: async (req) => {
      const url = new URL(req.url);
      const source = sourceOf(req);

      // Liveness for local tooling. A request that came through the tunnel
      // carries Cloudflare's header and gets no such courtesy.
      if (url.pathname === "/grok/health" && !req.headers.has("cf-connecting-ip")) {
        return new Response("ok");
      }
      if (!MCP_PATHS.has(url.pathname)) return new Response("not found", { status: 404 });

      if (failures.blocked(source)) return deny(429, "too many failed attempts");
      const caller = resolveCaller(presentedToken(req, opts.authMode), opts.token, opts.bots ?? []);
      if (!caller) {
        failures.take(source);
        // Never the URL: `?key=` is the token.
        log.warn("grok", "request rejected: bad or missing token", { source });
        return deny(401, "unauthorized", { "WWW-Authenticate": 'Bearer realm="edmund"' });
      }
      if (!requests.take("all")) return deny(429, "slow down");
      if (req.method !== "POST") return deny(405, "POST only", { Allow: "POST" });

      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) return deny(413, "request too large");
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return deny(413, "request too large");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return deny(400, "invalid JSON");
      }

      // The transport insists on both media types in Accept. A client that
      // forgets to offer them is still authenticated, so meet it halfway.
      const headers = new Headers(req.headers);
      headers.set("accept", "application/json, text/event-stream");
      headers.set("content-type", "application/json");
      const request = new Request(req.url, { method: "POST", headers, body: raw });

      const mcp = createConnectorServer({
        caller,
        maxMessageChars: opts.maxMessageChars,
        maxResultChars: opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
        allowAsk: () => asks.take("all"),
        allowReport: () => reports.take("all"),
        ask: opts.ask,
        tell: opts.tell,
        check: opts.check,
        report: opts.report,
        progressIntervalMs: opts.progressIntervalMs,
      });
      const streaming = wantsProgress(body);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: !streaming,
      });
      await mcp.connect(transport);
      const closeMcp = () => void mcp.close().catch(() => {});
      try {
        const res = await transport.handleRequest(request, { parsedBody: body });
        // A JSON answer is complete by now. An event stream is not: the handler
        // returns it open, with the tool still running behind it, so the server
        // stays up until the stream ends or the client hangs up.
        if (!streaming || !res.body) {
          closeMcp();
          return res;
        }
        const reader = res.body.getReader();
        const out = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                closeMcp();
              } else controller.enqueue(value);
            } catch (err) {
              controller.error(err);
              closeMcp();
            }
          },
          cancel(reason) {
            closeMcp();
            return reader.cancel(reason);
          },
        });
        return new Response(out, { status: res.status, headers: res.headers });
      } catch (err) {
        log.warn("grok", "mcp request failed", { err: String(err) });
        closeMcp();
        return deny(500, "internal error");
      }
    },
  });
  // `server.port` rather than `opts.port`: port 0 asks the OS for a free one.
  const port = server.port ?? opts.port;
  log.info("grok", `listener on 127.0.0.1:${port}`, {
    authMode: opts.authMode,
    identifiedBots: (opts.bots ?? []).map((b) => b.name),
  });
  return { stop: () => server.stop(), port };
}

/** True when the JSON-RPC body is a tool call carrying a progress token. */
function wantsProgress(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as { method?: unknown; params?: { _meta?: { progressToken?: unknown } } };
  return b.method === "tools/call" && b.params?._meta?.progressToken !== undefined;
}

function deny(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
