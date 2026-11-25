/**
 * The watch's listener: where every worker's tool calls arrive.
 *
 * It answers on loopback only, and only a caller holding the key minted at
 * start (address.ts). Two things come in from workers: a call about to run
 * (`/pre/<chat>`), answered with nothing to let it run or a refusal to stop
 * it, and a call that has run (`/post/<chat>`). A third path lets the
 * command line ask the running watch to do something (`/control`).
 *
 * An error anywhere in here answers "let it run". A worker waits on this for
 * every tool call it makes: the one thing this must never do is fail closed.
 */
import { type WatchAddress, announceWatch, withdrawWatch } from "../security/watch/address.ts";
import { log } from "../util/log.ts";
import type { ToolCall, Watch } from "./service.ts";

type HookBody = {
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  tool_response?: unknown;
};

function callOf(body: HookBody): ToolCall | null {
  if (typeof body.tool_name !== "string") return null;
  const input =
    body.tool_input && typeof body.tool_input === "object"
      ? (body.tool_input as Record<string, unknown>)
      : {};
  return {
    tool: body.tool_name,
    input,
    id: typeof body.tool_use_id === "string" ? body.tool_use_id : undefined,
  };
}

const LET_RUN = () => Response.json({});

/** What Claude Code reads as "do not run this call", with the reason shown to the model. */
function refusal(reason: string): Response {
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

export type Control = (action: string, body: Record<string, unknown>) => Promise<unknown>;

export type WatchServer = { address: WatchAddress; stop: () => void; slowest: () => number };

export function serveWatch(watch: Watch, dataDir: string, control: Control): WatchServer {
  let key = "";
  let slowestMs = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held call waits for the judge; the default would cut it off first.
    idleTimeout: 60,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${key}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const url = new URL(req.url);
      const [, route, rest] = /^\/([a-z]+)(?:\/(.*))?$/.exec(url.pathname) ?? [];
      try {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (route === "control") {
          return Response.json(await control(String(body.action ?? ""), body));
        }
        const session = rest ? decodeURIComponent(rest) : "";
        const call = callOf(body);
        if (!session || !call) return LET_RUN();
        if (route === "pre") {
          const started = performance.now();
          const decision = await watch.before(session, call);
          slowestMs = Math.max(slowestMs, performance.now() - started);
          return decision.allow ? LET_RUN() : refusal(decision.reason);
        }
        if (route === "post") await watch.after(session, call, body.tool_response);
        return LET_RUN();
      } catch (err) {
        log.warn("watch", "a hook call failed inside the watch, and was let run", {
          route,
          err: (err as Error).message.slice(0, 200),
        });
        return route === "control"
          ? Response.json({ ok: false, error: (err as Error).message })
          : LET_RUN();
      }
    },
  });
  const address = announceWatch(dataDir, server.port ?? 0);
  key = address.key;
  return {
    address,
    slowest: () => slowestMs,
    stop: () => {
      withdrawWatch(dataDir);
      server.stop(true);
    },
  };
}

/** Ask a running watch to do something, from another process. Null when none is running. */
export async function askWatch(
  address: WatchAddress | null,
  action: string,
  body: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<unknown | null> {
  if (!address) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${address.key}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, action }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
