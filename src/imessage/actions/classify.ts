/**
 * Whether a failed operation is worth trying again.
 *
 * The old classifier matched substrings of whatever the CLI happened to print
 * ("timed out", "is not allowed", "busy"), which meant a reworded message
 * silently changed how the harness recovered. imcore-bridge raises typed errors
 * instead, so the decision is made on the error's class and code.
 *
 * Retrying is only safe because every send carries an idempotency key: a repeat
 * inside the window returns the original result rather than sending twice.
 */

/** Error codes that describe a condition that may clear on its own. */
const TRANSIENT_CODES = new Set([
  // The bridge accepted the request and did not answer in time.
  "timeout",
  // Messages is up but IMCore is not ready to serve yet.
  "not_ready",
  // Nothing is connected — the supervisor is relaunching Messages right now.
  "bridge_unavailable",
  "bridge_not_running",
  // The daemon's control socket was unreachable, e.g. it is restarting.
  "control_unreachable",
  // Every safe self-route recovery round was exhausted. The payload is fine;
  // park it until Apple's chat registry settles rather than asking the model
  // to rewrite an answer that was never the problem.
  "self_route_unrecovered",
  // Quick retries are exhausted, but nothing is lost: the reply is queued and
  // the outbox drainer keeps trying every 10s. Transient is the whole point —
  // treating it as permanent would drop a perfectly good reply.
  "self_route_retrying",
]);

/** Error class names that mean the same, for errors that carry no code. */
const TRANSIENT_NAMES = new Set([
  "RpcTimeoutError",
  "BridgeUnavailableError",
  "BridgeNotRunningError",
  "ControlUnreachableError",
  "SelfRouteRecoveryError",
  "SelfRouteTransientError",
]);

export function isTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_NAMES.has(error.name);
}

/**
 * Renders an error for a `SendResult`, keeping the class and code readable.
 *
 * Callers that only have the string — `isPermanentSendError` in the recovery
 * paths — read the marker, so it is our own stable format rather than a
 * vendor's prose.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: string }).code;
  const label = code ? `${error.name}[${code}]` : error.name;
  return `${label}: ${error.message}`;
}

/**
 * Whether a rendered error describes a permanent failure.
 *
 * Permanent means the same payload will fail the same way: an unsupported
 * selector, a chat that does not exist, a file Messages refused. Callers use it
 * to choose between parking the message for later and telling the model to
 * reformat it.
 */
export function isPermanentSendError(error: string): boolean {
  for (const name of TRANSIENT_NAMES) {
    // A bounded retry wraps the final rendered error with
    // "after N attempts: ...". Requiring the class at offset zero turned that
    // wrapper into a permanent failure and discarded an otherwise valid reply.
    if (error.includes(`${name}:`) || error.includes(`${name}[`)) return false;
  }
  for (const code of TRANSIENT_CODES) {
    if (error.includes(`[${code}]:`)) return false;
  }
  return true;
}
