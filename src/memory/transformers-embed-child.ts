/**
 * Local embedding runner, as its own process.
 *
 * Transformers.js/ONNX exposes an async API, but its native inference work
 * occupies the JavaScript thread that called it, so it cannot live in the
 * daemon's own thread. It used to live in a Worker thread. That is what took
 * recall down: on Bun 1.3.9, what a worker thread adds to the runtime's
 * process-wide module cache dies once workers are created and terminated, and
 * the next worker's `import("@huggingface/transformers")` then answers
 * "Cannot find module" until the daemon restarts, or segfaults the daemon
 * (measured 2026-11-25: 5 of 30 daemon-shaped processes within 300 reloads;
 * 13 crash reports in the daemon's stderr since September). Newer Bun
 * releases misbehave differently with the same shape, so the embedder no
 * longer depends on it.
 *
 * A process shares nothing with the daemon. Ending it always gives the
 * model's memory back, and a fresh one starts clean, which is what makes
 * "start it again" an actual repair.
 */

import { type EmbedLane, laneScheduler } from "./embed-lanes.ts";

type Pooling = "mean" | "cls";

export type EmbedRequest = {
  id: number;
  model: string;
  pooling: Pooling;
  texts: string[];
  /** Absent from callers that predate lanes: treated as index work. */
  lane?: EmbedLane;
};

export type EmbedResponse =
  | { id: number; ok: true; data: Float32Array; dim: number }
  /** `load`: the model could not be loaded, so this process is of no use to
   *  anyone and the owner replaces it. `run`: this one request failed. */
  | { id: number; ok: false; error: string; stage: "load" | "run" };

/** Sent once, when the process is listening. Requests wait for it. */
export type EmbedReady = { ready: true };

type FeatureExtractor = (
  input: string | string[],
  opts?: { pooling?: Pooling | "none"; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

const pipelines = new Map<string, Promise<FeatureExtractor>>();

function loadPipeline(model: string): Promise<FeatureExtractor> {
  const existing = pipelines.get(model);
  if (existing) return existing;

  const loading = (async () => {
    const mod = await import("@huggingface/transformers");
    const { pipeline, env } = mod;
    try {
      const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;
      const e = env as unknown as {
        allowLocalModels?: boolean;
        backends?: { onnx?: { wasm?: { numThreads?: number; simd?: boolean } } };
      };
      e.allowLocalModels = true;
      if (e.backends?.onnx?.wasm) {
        // Leave a core available for the daemon and Messages bridge.
        e.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, cores - 1));
        e.backends.onnx.wasm.simd = true;
      }
    } catch {
      // Best effort across Transformers.js backend/version differences.
    }
    return (await pipeline("feature-extraction", model)) as unknown as FeatureExtractor;
  })();
  pipelines.set(model, loading);
  // A failed load is never the answer for the rest of the process's life.
  loading.catch(() => {
    if (pipelines.get(model) === loading) pipelines.delete(model);
  });
  return loading;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function reply(message: EmbedResponse | EmbedReady): void {
  // The owner may already be gone; the disconnect handler ends this process.
  try {
    process.send?.(message);
  } catch {}
}

// One pipeline instance is not safe to drive concurrently. Serialising here
// also prevents an auto-recall query from racing an indexer batch inside ONNX;
// queries go first (embed-lanes.ts).
const push = laneScheduler<EmbedRequest>(
  (request) => request.lane ?? "index",
  async (request) => {
    let extract: FeatureExtractor;
    try {
      extract = await loadPipeline(request.model);
    } catch (error) {
      reply({ id: request.id, ok: false, error: describe(error), stage: "load" });
      return;
    }
    try {
      const out = await extract(request.texts, { pooling: request.pooling, normalize: true });
      const dim = out.dims[out.dims.length - 1] ?? 0;
      reply({ id: request.id, ok: true, data: out.data, dim });
    } catch (error) {
      reply({ id: request.id, ok: false, error: describe(error), stage: "run" });
    }
  },
);

if (typeof process.send === "function") {
  // Never outlive the owner. Its end closes the channel, whether it exited,
  // crashed or was killed (measured 2026-11-25 with the model loaded).
  process.on("disconnect", () => process.exit(0));
  process.on("message", (request: EmbedRequest) => push(request));
  reply({ ready: true });
}
