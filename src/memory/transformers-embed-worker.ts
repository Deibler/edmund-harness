/**
 * Worker-side local embedding runner.
 *
 * Transformers.js/ONNX exposes an async API, but its native inference work can
 * occupy Bun's calling JavaScript thread until a batch finishes. Running it in
 * a Web Worker keeps the daemon's socket, timers, and bridge health probes
 * responsive while recall backfills are active.
 */

type Pooling = "mean" | "cls";

// Bun exposes a Web-Worker-compatible global but this project intentionally
// omits the browser DOM lib from tsconfig; declare only the surface used here.
declare const self: Worker;

type EmbedRequest = {
  id: number;
  model: string;
  pooling: Pooling;
  texts: string[];
};

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
  return loading;
}

// One pipeline instance is not safe to drive concurrently. Serialising here
// also prevents an auto-recall query from racing an indexer batch inside ONNX.
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<EmbedRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      const fe = await loadPipeline(request.model);
      const out = await fe(request.texts, {
        pooling: request.pooling,
        normalize: true,
      });
      const dim = out.dims[out.dims.length - 1] ?? 0;
      self.postMessage({ id: request.id, ok: true, data: out.data, dim });
    } catch (error) {
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  });
};
