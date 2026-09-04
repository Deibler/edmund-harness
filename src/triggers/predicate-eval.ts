/**
 * Worker runner for model-authored trigger predicates. Receives
 * {predicate, data, state}, runs the function body, and posts
 * {ok, fire, summary, scratch} back to its owner.
 *
 * Runs in its own short-lived worker so a runaway predicate (infinite loop,
 * pathological regex) is terminated by the daemon's timeout instead of
 * wedging the event loop that every session shares. Interpretation of the
 * return value (boolean vs {fire, summary}) happens HERE so nothing
 * non-JSON-serializable has to cross the process boundary.
 */

self.onmessage = (event: MessageEvent<PredicateRequest>) => {
  try {
    const { predicate, data, state } = event.data;
    const fn = new Function("data", "state", predicate) as (
      data: unknown,
      state: Record<string, unknown>,
    ) => unknown;
    const out = fn(data, state);

    let fire = false;
    let summary: string;
    if (typeof out === "boolean") {
      fire = out;
      summary = out ? "predicate returned true" : "predicate returned false";
    } else if (out && typeof out === "object") {
      const o = out as { fire?: unknown; summary?: unknown };
      fire = o.fire === true;
      summary =
        typeof o.summary === "string" && o.summary.trim()
          ? o.summary
          : fire
            ? "predicate fired (no summary given)"
            : "no fire";
    } else {
      summary = `predicate returned ${typeof out} (treated as no-fire)`;
    }

    self.postMessage({ ok: true, fire, summary, scratch: state });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

type PredicateRequest = {
  predicate: string;
  data: unknown;
  state: Record<string, unknown>;
};
