/**
 * Who is calling through the Grok connector, as decided by the key they presented.
 *
 * Until each Grok Bot had its own connector key, every caller shared one token
 * and could only be told apart by introducing itself, which a bot can get wrong
 * or be talked into. A bot's own `connector_token` is proof of who it is: the
 * server resolves it at the door (`resolveCaller` in auth.ts), and the answer
 * rides with the request through every tool, the inbound, the envelope's `From:`
 * line and the exchange log.
 *
 * Two kinds:
 *   - `shared`: the `[grok].token` key. The car's Grok uses it, and so does any
 *     bot that was not given its own key, so the key says nothing about which.
 *   - `bot`: a `[grok.bots.<name>].connector_token`. The name is the config key,
 *     the same one `grokbot_task` and a pending reply_id use.
 *
 * Plain data on purpose: it is persisted with a parked message (session-queue.ts)
 * and must survive a restart. It never holds a token.
 */
export type GrokCaller =
  | { kind: "shared" }
  | {
      kind: "bot";
      /** The `[grok.bots.<name>]` key. */
      bot: string;
      /** What to call it: `label`, else the name. */
      label: string;
      /** One line on what the bot is like, from `description`. Optional. */
      description?: string;
    };

export const SHARED_CALLER: GrokCaller = { kind: "shared" };

/** Short display name for logs and the exchange log. */
export function callerName(caller: GrokCaller): string {
  return caller.kind === "bot" ? caller.label : "Grok (shared key)";
}

/** The shortest tag, for marking one message among several: "Glep" or "shared key". */
export function callerShort(caller: GrokCaller): string {
  return caller.kind === "bot" ? caller.label : "shared key";
}

/** The short name with what the key proves, for the exchange log:
 *  "Glep (verified by its own key)" or "Grok (shared key)". */
export function callerTag(caller: GrokCaller): string {
  return caller.kind === "bot" ? `${caller.label} (verified by its own key)` : callerName(caller);
}

/**
 * The caller as the envelope's `From:` line names it, without the "calling for"
 * tail: "Glep (a deliberately simple Grok bot, verified by its own key)",
 * "Grok Bot (verified by its own key)", or for the shared key the car's
 * Grok and any bot that did not use its own key.
 */
export function describeCaller(caller: GrokCaller): string {
  if (caller.kind === "shared") {
    return "Grok connector (shared key: the car's Grok or a bot that did not use its own key)";
  }
  const about = caller.description?.trim();
  return about
    ? `${caller.label} (${about}, verified by its own key)`
    : `${caller.label} (verified by its own key)`;
}

/** True for a value that came back from JSON and is shaped like a caller. */
export function isGrokCaller(v: unknown): v is GrokCaller {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.kind === "shared") return true;
  return (
    c.kind === "bot" &&
    typeof c.bot === "string" &&
    typeof c.label === "string" &&
    (c.description === undefined || typeof c.description === "string")
  );
}

/** The task went to `sentTo`; the report came on another bot's own key. The
 *  shared key never mismatches: it cannot say which bot it is. */
export function reportMismatch(sentTo: string, caller: GrokCaller): boolean {
  return caller.kind === "bot" && caller.bot !== sentTo;
}

/** The warning that goes into a report that arrived on the wrong bot's key. */
export function mismatchNote(sentTo: string, caller: GrokCaller): string {
  if (!reportMismatch(sentTo, caller) || caller.kind !== "bot") return "";
  return `Mismatch: this task was sent to bot "${sentTo}", but the report arrived on ${caller.label}'s own connector key (bot "${caller.bot}"). It was accepted anyway. Treat who actually did the work as uncertain, and say so if it matters.`;
}
