/**
 * Turning a Twilio webhook POST into something the harness already understands.
 *
 * The pipeline, the gate, the envelope and the persona layer all speak
 * `InboundMessage`. Rather than teach each of them about SMS, the webhook
 * builds one — exactly the trick the mirror already uses for voice turns
 * (`integrations/mirror/src/orchestrator.ts:inboundFor`). Everything
 * downstream then works unchanged, and `service: "SMS"` is a value the type
 * has always carried.
 */

/**
 * Carrier-mandated keywords.
 *
 * These are recognized case-insensitively on a message whose ENTIRE body is
 * the keyword, ignoring surrounding whitespace and trailing punctuation. The
 * strictness is deliberate: "stop by the store when you can" must never be
 * read as a revocation, and a substring match would do exactly that. CTIA
 * requires the bare keyword to work; it does not require us to guess.
 */
export const STOP_KEYWORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "REVOKE",
] as const;
export const START_KEYWORDS = ["START", "YES", "UNSTOP"] as const;
export const HELP_KEYWORDS = ["HELP", "INFO"] as const;

export type Keyword = "stop" | "start" | "help" | null;

/** Which carrier keyword, if any, this body is exactly. */
export function classifyKeyword(body: string): Keyword {
  const t = body
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .toUpperCase();
  if (!t) return null;
  if ((STOP_KEYWORDS as readonly string[]).includes(t)) return "stop";
  if ((START_KEYWORDS as readonly string[]).includes(t)) return "start";
  if ((HELP_KEYWORDS as readonly string[]).includes(t)) return "help";
  return null;
}

/**
 * The reply body for a keyword, or null to stay silent.
 *
 * Returning null matters: when Twilio's Advanced Opt-Out is enabled on the
 * messaging service, Twilio answers STOP/HELP/START itself, and replying here
 * too would send the person two messages. The caller passes
 * `carrierHandlesKeywords` from config so the behavior is chosen once, in
 * configuration, rather than guessed per request.
 */
export function keywordReply(
  kind: Exclude<Keyword, null>,
  opts: { carrierHandlesKeywords: boolean; helpText: string },
): string | null {
  if (opts.carrierHandlesKeywords) return null;
  switch (kind) {
    case "stop":
      return "You have been unsubscribed and will receive no further messages from this number. Reply START to resubscribe.";
    case "start":
      return "You are now opted in to receive text messages. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
    case "help":
      return opts.helpText;
  }
}
