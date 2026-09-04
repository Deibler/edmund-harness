/**
 * Short, sortable, collision-resistant IDs with a type prefix.
 *
 *   genId("job")   → "job_20260512T143002_3f8a1c_0"
 *   genId("agent") → "agent_20260512T143002_9b2e4d_1"
 *
 * Three segments after the prefix:
 *  - a UTC timestamp (YYYYMMDDTHHMMSS) so IDs sort roughly by creation time;
 *  - 6 hex chars from `crypto.randomUUID` — a CSPRNG, so IDs from different
 *    processes (the daemon + spawned runners) don't collide;
 *  - a per-process monotonic counter (base-36) — guarantees uniqueness for
 *    any number of IDs minted within one process, even in the same ms.
 */
let counter = 0;

export function genId(prefix: string): string {
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15); // YYYYMMDDTHHMMSS
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  const seq = (counter++).toString(36);
  return `${prefix}_${ts}_${rand}_${seq}`;
}
