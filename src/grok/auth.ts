import { createHash, timingSafeEqual } from "node:crypto";
import { type GrokCaller, SHARED_CALLER } from "./caller.ts";

/**
 * Where the shared token may be presented. `both` is the default because the
 * connector UI Grok offers may only take a URL, in which case the token has to
 * ride in `?key=`; once the connector's real auth options are known, narrow it
 * in `[grok].auth_mode`.
 */
export type GrokAuthMode = "both" | "bearer" | "query";

/** The token the request presents under `mode`, or null. */
export function presentedToken(req: Request, mode: GrokAuthMode): string | null {
  if (mode !== "query") {
    const header = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (m) return m[1]!;
  }
  if (mode !== "bearer") {
    const key = new URL(req.url).searchParams.get("key");
    if (key) return key;
  }
  return null;
}

/**
 * Constant-time comparison. Hashing first gives both sides one fixed length, so
 * neither the content nor the length of the real token shows in the timing.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** A Grok Bot that has its own connector key: what the server needs to know it. */
export type ConnectorBot = {
  /** The `[grok.bots.<name>]` key. */
  name: string;
  /** `[grok.bots.<name>].connector_token`. Never logged. */
  token: string;
  label: string;
  description?: string;
};

/**
 * Which caller a presented token belongs to, or null when it is nobody's.
 *
 * The shared `[grok].token` is the car's Grok and any bot without a key of its
 * own, so it keeps working exactly as before. A bot's `connector_token` names
 * that bot. Every candidate is compared, in constant time, with no early exit, so
 * neither the content of a key nor which caller it belongs to shows in the timing.
 * If a bot's token equals the shared one the shared identity wins (the channel
 * drops such a token at startup and says so).
 */
export function resolveCaller(
  presented: string | null,
  sharedToken: string,
  bots: readonly ConnectorBot[],
): GrokCaller | null {
  let caller: GrokCaller | null = null;
  if (tokenMatches(presented, sharedToken)) caller = SHARED_CALLER;
  for (const bot of bots) {
    if (!tokenMatches(presented, bot.token) || caller) continue;
    caller = {
      kind: "bot",
      bot: bot.name,
      label: bot.label,
      ...(bot.description ? { description: bot.description } : {}),
    };
  }
  return caller;
}

/** Who is knocking, for rate limiting. Behind the tunnel every socket peer is
 *  loopback, so the real address comes from Cloudflare's header. */
export function sourceOf(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}
