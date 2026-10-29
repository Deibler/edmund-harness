/**
 * The order the embedding worker runs requests in: one at a time (one ONNX
 * pipeline is not safe to drive concurrently), live recall queries before
 * index batches.
 *
 * The worker used to run requests first in, first out. A query embeds in
 * 3-4 ms, but it waited behind whatever index batches were already queued:
 * the daemon's median query embed was 730 ms from 2026-10-26, against about
 * 20 ms before, while the indexer re-embedded thousands of person-file
 * chunks a day on the same worker. A batch already running cannot be
 * interrupted, so index requests are also kept small (INDEX_EMBED_BATCH).
 */
export type EmbedLane = "query" | "index";

/**
 * Returns `push`: queue an item on its lane. Items run one at a time through
 * `run`; when one finishes, the next query goes before any queued index item.
 */
export function laneScheduler<T>(
  laneOf: (item: T) => EmbedLane,
  run: (item: T) => Promise<void>,
): (item: T) => void {
  const lanes: Record<EmbedLane, T[]> = { query: [], index: [] };
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      for (let next = lanes.query.shift() ?? lanes.index.shift(); next !== undefined; ) {
        await run(next);
        next = lanes.query.shift() ?? lanes.index.shift();
      }
    } finally {
      running = false;
    }
  };
  return (item) => {
    lanes[laneOf(item)].push(item);
    void drain();
  };
}
