/**
 * When a failing trigger stops being a blip. Kept apart from the watcher so
 * the log view can read the same numbers without loading the probe stack.
 */

/** Escalate to the operator at exactly this many consecutive failures. */
export const PERSISTENT_FAILURE_ALERT_AT = 5;

/**
 * Give up at this many consecutive failures and disarm.
 *
 * The alert at 5 assumed someone would then repair or cancel the trigger.
 * Nobody does — the alert is one line in a busy thread, and the backoff
 * floor below means the corpse keeps probing hourly regardless. Three
 * kitchen triggers reached 100+ consecutive failures over four days, each
 * pointed at a `trycloudflare.com` hostname that had been regenerated,
 * i.e. at a URL that could never come back. Past a day of solid failure
 * the endpoint is gone, not flaky, and retrying is pure noise.
 */
export const PERSISTENT_FAILURE_DISARM_AT = 24;
