/**
 * Failure classification for the recovery system.
 *
 * Pure: a single error string in, a structured class + human description
 * out. Adding a new failure mode is one row in `CLASSIFIERS` plus one row
 * in `DESCRIPTIONS`. Tested table-driven so a regression on either is loud.
 */

export type FailureClass =
  | "request_too_large"
  | "image_dim_exceeded"
  | "stale_session_id"
  | "session_in_use"
  | "bad_tool_ids"
  | "invalid_tool_schema"
  | "empty_content_block"
  | "transient_api"
  | "send_failed"
  | "unknown";

type ClassifierRow = {
  /** Pattern matched against the raw runner error string. */
  pattern: RegExp;
  cls: FailureClass;
};

/**
 * Order matters — first match wins. Put more-specific patterns before
 * generic ones. All patterns are anchored loosely (no `^`/`$`) so they
 * survive whatever framing the selected CLI wraps the underlying error in.
 */
const CLASSIFIERS: ClassifierRow[] = [
  // 32 MB cap (cumulative session payload exceeded the request limit).
  { pattern: /request too large/i, cls: "request_too_large" },
  { pattern: /max(?:imum)?\s*(?:request\s*)?(?:size|payload)/i, cls: "request_too_large" },
  // Single image exceeded the 2000px dim cap in a many-image request.
  { pattern: /exceeds the dimension limit/i, cls: "image_dim_exceeded" },
  { pattern: /image[^.]*?2000\s*px/i, cls: "image_dim_exceeded" },
  // Stored thread UUID is gone from the provider CLI's local store.
  { pattern: /no conversation found/i, cls: "stale_session_id" },
  { pattern: /session not found/i, cls: "stale_session_id" },
  { pattern: /unknown session/i, cls: "stale_session_id" },
  // Two `--resume` against the same session UUID simultaneously.
  { pattern: /already in use/i, cls: "session_in_use" },
  // Persisted tool ids the API rejects on resume ("messages.N.content.0.
  // tool_use.id: String should match pattern ..."). session-repair.ts
  // fixes exactly this; the healer runs it reactively + evicts the warm
  // worker (which holds the broken transcript in memory).
  { pattern: /tool_use[\s\S]{0,120}should match pattern/i, cls: "bad_tool_ids" },
  { pattern: /tool_use_id[\s\S]{0,120}should match pattern/i, cls: "bad_tool_ids" },
  // A tool published an input schema the API rejects against the 2020-12
  // meta-schema ("tools.N.custom.input_schema: JSON schema is invalid") —
  // static server code, so EVERY request including the tool fails identically
  // until the converter/tool is fixed. zod-to-json.ts meta-validates at
  // publish time precisely so this never fires; the row is the tripwire for
  // a gap in that guard (took the Alex DM down for 26 min, 2026-08-17).
  { pattern: /input_schema[\s\S]{0,80}JSON schema is invalid/i, cls: "invalid_tool_schema" },
  // A persisted turn with an empty text block — the API rejects the whole
  // resume. No healer yet; classified so it stops polluting `unknown` and
  // reads honestly in the recovery envelope.
  { pattern: /text content blocks must be non-empty/i, cls: "empty_content_block" },
  // imsg IMCore bridge wedge: dylib in Messages.app stopped ACK'ing RPCs.
  // Heal by relaunching Messages with `imsg launch` (re-injects the dylib).
  // Matched BEFORE the generic /timeout/ pattern so it wins over transient_api.
  { pattern: /timed out waiting for response/i, cls: "send_failed" },
  { pattern: /bridge wedged and recovery failed/i, cls: "send_failed" },
  { pattern: /imsg exit \d+/i, cls: "send_failed" },
  // Transient API issues — retry without intervention typically clears them.
  { pattern: /rate.?limit|429/i, cls: "transient_api" },
  { pattern: /overloaded|503|502|504/i, cls: "transient_api" },
  // "Unable to connect to API (ConnectionRefused)" was the #2 production
  // error (40×) and fell to `unknown` because only the ETIMEDOUT-family
  // strings were listed.
  { pattern: /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i, cls: "transient_api" },
  { pattern: /unable to connect/i, cls: "transient_api" },
];

export function classifyError(msg: string | null | undefined): FailureClass {
  if (!msg) return "unknown";
  for (const row of CLASSIFIERS) {
    if (row.pattern.test(msg)) return row.cls;
  }
  return "unknown";
}

/**
 * Single-sentence human description, written to be read by the model
 * inside the recovery envelope (so it knows what happened) but never
 * surfaced to the user. `healed` toggles past-tense + reassurance when
 * the harness fixed the underlying problem before invoking the model.
 */
export function describeErrorClass(
  cls: FailureClass,
  healed: boolean,
  rawError?: string | null,
): string {
  const suffix = healed
    ? " The harness fixed it automatically; the conversation continues normally now."
    : " The fix may not have stuck — proceed cautiously.";
  switch (cls) {
    case "request_too_large":
      return `An earlier attempt to reply failed because the cumulative session payload exceeded Claude's 32 MB request limit. The harness compacted older images out of the session history.${suffix}`;
    case "image_dim_exceeded":
      return `An earlier attempt to reply failed because the session contained an image larger than the 2000 px many-image dimension limit. The harness downscaled the offending image.${suffix}`;
    case "stale_session_id":
      return `An earlier attempt to reply found the stored provider thread id was no longer valid. The next turn will cold-start.${suffix}`;
    case "session_in_use":
      return `An earlier attempt collided with another in-flight turn on this session and was rolled back. No state was corrupted.`;
    case "bad_tool_ids":
      return `An earlier attempt to resume failed because the persisted session contained tool ids the API rejects. The harness rewrote the ids in place and restarted the session worker.${suffix}`;
    case "invalid_tool_schema":
      return `An earlier attempt to reply was rejected because a tool's published input schema is not valid JSON Schema draft 2020-12. This is a harness code bug, not a transient error — every request that includes the tool fails the same way, so retrying cannot help until the harness is fixed and restarted.`;
    case "empty_content_block":
      return `An earlier attempt to resume failed because a persisted turn contained an empty text block the API rejects. The conversation may need a fresh start if this recurs.`;
    case "transient_api":
      return `An earlier attempt hit a transient API issue (rate limit / overload / network). The condition has likely cleared.`;
    case "send_failed":
      return `An earlier reply was generated successfully but failed to deliver because the iMessage IMCore bridge dylib stopped responding. The harness relaunched Messages.app to re-inject the bridge.${suffix}`;
    case "unknown":
      return rawError
        ? `An earlier attempt failed with: "${rawError.slice(0, 200)}". The cause is not yet classified.`
        : "An earlier attempt to reply failed without a recognized cause.";
  }
}
