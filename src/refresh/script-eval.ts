/**
 * Worker runner for model-authored refresh scripts. Receives a script body,
 * runs its ASYNC function (bun's global `fetch` is
 * available — that's the point: fetch + shape data with no model turn), and
 * posts {ok, value} back to its owner.
 *
 * Same liveness rationale as triggers/predicate-eval.ts: the daemon terminates
 * this worker at the timeout, so a hung fetch or runaway loop can't wedge
 * the shared event loop.
 */

self.onmessage = async (event: MessageEvent<{ script: string }>) => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => () => Promise<unknown>;
    const fn = new AsyncFunction(event.data.script);
    const value = await fn();
    self.postMessage({ ok: true, value });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
