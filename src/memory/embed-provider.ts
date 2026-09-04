/**
 * Embedding provider abstraction. Two real impls (OpenAI HTTP, Ollama
 * HTTP) and a deterministic test stub. All return unit vectors of the
 * provider's reported dim — the vector store records (model, dim) on
 * insert and refuses to mix shapes.
 */

export type EmbedResult = { vectors: Float32Array[]; model: string; dim: number };

export interface EmbedProvider {
  model: string;
  dim: number;
  /** Embed DOCUMENTS (index side). */
  embed(texts: string[]): Promise<EmbedResult>;
  /** Embed QUERIES (search side). Retrieval-tuned models (bge, arctic)
   *  were trained with an instruction prefix on the query side ONLY —
   *  omitting it costs several nDCG points. Providers without an
   *  asymmetric contract fall back to embed(). */
  embedQuery?(texts: string[]): Promise<EmbedResult>;
}

/** Search-side embedding with the model's query contract applied. */
export function embedQuery(provider: EmbedProvider, texts: string[]): Promise<EmbedResult> {
  return provider.embedQuery ? provider.embedQuery(texts) : provider.embed(texts);
}

export type ProviderConfig = {
  provider: "openai" | "ollama" | "transformers" | "none";
  model: string;
  dim: number;
  ollamaEndpoint: string;
  openaiKey: string;
};

// A daemon process has several recall entry points (boot indexing, automatic
// recall, artifact indexing, and summary persistence). They used to each make
// their own local Transformers provider, which meant one ONNX model + worker
// thread per entry point. Keep exactly one provider per model/dimension in a
// process; its worker already serializes inference safely.
const transformersProviders = new Map<string, TransformersEmbedProvider>();

function sharedTransformersProvider(model: string, dim: number): TransformersEmbedProvider {
  const key = `${model}\u0000${dim}`;
  let provider = transformersProviders.get(key);
  if (!provider) {
    provider = new TransformersEmbedProvider(model, dim);
    transformersProviders.set(key, provider);
  }
  return provider;
}

/** Release idle local-model workers under memory pressure. Active embedding
 * calls are never interrupted; they will be eligible on the next pass. */
export function trimTransformerEmbeddingWorkers(): number {
  let trimmed = 0;
  for (const provider of transformersProviders.values()) {
    if (provider.trimIdleWorker()) trimmed++;
  }
  return trimmed;
}

export function makeProvider(cfg: ProviderConfig): EmbedProvider {
  switch (cfg.provider) {
    case "openai":
      return new OpenAIEmbedProvider(cfg.model, cfg.dim, cfg.openaiKey);
    case "ollama":
      return new OllamaEmbedProvider(cfg.model, cfg.dim, cfg.ollamaEndpoint);
    case "transformers":
      return sharedTransformersProvider(cfg.model, cfg.dim);
    case "none":
      return new NullEmbedProvider(cfg.model, cfg.dim);
  }
}

class OpenAIEmbedProvider implements EmbedProvider {
  constructor(
    public model: string,
    public dim: number,
    private key: string,
  ) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    if (!this.key) throw new Error("openai key missing for embeddings");
    if (texts.length === 0) return { vectors: [], model: this.model, dim: this.dim };
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts, encoding_format: "float" }),
    });
    if (!r.ok) throw new Error(`openai embed http ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    return {
      vectors: j.data.map((d) => Float32Array.from(d.embedding)),
      model: this.model,
      dim: this.dim,
    };
  }
}

class OllamaEmbedProvider implements EmbedProvider {
  constructor(
    public model: string,
    public dim: number,
    private endpoint: string,
  ) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    const out: Float32Array[] = [];
    for (const t of texts) {
      const r = await fetch(`${this.endpoint}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: t }),
      });
      if (!r.ok) throw new Error(`ollama embed http ${r.status}: ${await r.text()}`);
      const j = (await r.json()) as { embedding: number[] };
      out.push(Float32Array.from(j.embedding));
    }
    return { vectors: out, model: this.model, dim: this.dim };
  }
}

/**
 * Model-family quirks the provider must respect. MiniLM-era models
 * mean-pool with no prefixes; the stronger retrieval-tuned small models
 * (bge-small-en-v1.5, snowflake-arctic-embed) CLS-pool and expect the
 * BGE instruction prefix on QUERIES only (documents stay bare).
 */
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

function familyFor(model: string): { pooling: "mean" | "cls"; queryPrefix: string } {
  const m = model.toLowerCase();
  if (m.includes("bge-") || m.includes("arctic-embed")) {
    return { pooling: "cls", queryPrefix: BGE_QUERY_PREFIX };
  }
  return { pooling: "mean", queryPrefix: "" };
}

type WorkerEmbedResponse =
  | { id: number; ok: true; data: Float32Array; dim: number }
  | { id: number; ok: false; error: string };

type PendingEmbed = {
  textCount: number;
  resolve: (result: EmbedResult) => void;
  reject: (error: Error) => void;
};

/**
 * Local embeddings via @huggingface/transformers (Transformers.js).
 *
 * The model pipeline lives in a worker thread. Although Transformers.js
 * returns a Promise, ONNX inference itself occupies the JavaScript thread that
 * called it; keeping that work in the daemon used to stall bridge RPC and
 * health timers for whole indexing batches. The worker is lazy and retains the
 * loaded model between calls.
 *
 * Pooling + query prefix follow the model family (see familyFor); output is
 * L2-normalized either way.
 */
class TransformersEmbedProvider implements EmbedProvider {
  private static readonly WORKER_IDLE_MS = 5 * 60_000;
  private worker: Worker | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEmbed>();

  constructor(
    public model: string,
    public dim: number,
  ) {}

  private getWorker(): Worker {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./transformers-embed-worker.ts", import.meta.url), {
      name: "recall-embeddings",
      ref: false,
    });
    worker.onmessage = (event: MessageEvent<WorkerEmbedResponse>) => {
      const response = event.data;
      const call = this.pending.get(response.id);
      if (!call) return;
      this.pending.delete(response.id);
      if (this.pending.size === 0) {
        worker.unref();
        this.armIdleTermination(worker);
      }

      if (!response.ok) {
        call.reject(new Error(response.error));
        return;
      }
      if (response.dim <= 0 || response.data.length !== call.textCount * response.dim) {
        call.reject(
          new Error(
            `embedding worker returned ${response.data.length} values for ` +
              `${call.textCount} texts at dim ${response.dim}`,
          ),
        );
        return;
      }
      const vectors: Float32Array[] = [];
      for (let i = 0; i < call.textCount; i++) {
        vectors.push(response.data.slice(i * response.dim, (i + 1) * response.dim));
      }
      call.resolve({ vectors, model: this.model, dim: response.dim });
    };
    worker.onerror = (event: ErrorEvent) => {
      this.failWorker(worker, new Error(event.message || "embedding worker crashed"));
    };
    worker.addEventListener("close", () => {
      this.failWorker(worker, new Error("embedding worker exited"));
    });
    this.worker = worker;
    return worker;
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.worker = null;
    worker.terminate();
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      call.reject(error);
    }
  }

  private armIdleTermination(worker: Worker): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timer = setTimeout(() => {
      if (this.worker !== worker || this.pending.size > 0) return;
      this.idleTimer = null;
      this.worker = null;
      worker.terminate();
    }, TransformersEmbedProvider.WORKER_IDLE_MS);
    timer.unref?.();
    this.idleTimer = timer;
  }

  /** Synchronous pressure valve used by the daemon resource governor. */
  trimIdleWorker(): boolean {
    const worker = this.worker;
    if (!worker || this.pending.size > 0) return false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.worker = null;
    worker.terminate();
    return true;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return this.run(texts);
  }

  async embedQuery(texts: string[]): Promise<EmbedResult> {
    const { queryPrefix } = familyFor(this.model);
    return this.run(queryPrefix ? texts.map((t) => queryPrefix + t) : texts);
  }

  private async run(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model: this.model, dim: this.dim };
    const worker = this.getWorker();
    const id = this.nextRequestId++;
    return new Promise<EmbedResult>((resolve, reject) => {
      this.pending.set(id, { textCount: texts.length, resolve, reject });
      // An unresolved Promise does not keep a process alive. Hold the worker
      // only while calls are outstanding; idle local-model workers are free to
      // let one-shot MCP/indexing processes exit normally.
      worker.ref();
      try {
        worker.postMessage({
          id,
          model: this.model,
          pooling: familyFor(this.model).pooling,
          texts,
        });
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) {
          worker.unref();
          this.armIdleTermination(worker);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

class NullEmbedProvider implements EmbedProvider {
  constructor(
    public model: string,
    public dim: number,
  ) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    return {
      vectors: texts.map(() => new Float32Array(this.dim)),
      model: this.model,
      dim: this.dim,
    };
  }
}

/**
 * Deterministic hash-based embedder for tests. Maps each unique token
 * to a stable index in a small vector so that texts sharing tokens
 * have higher cosine similarity. Not for production.
 */
export class HashEmbedProvider implements EmbedProvider {
  constructor(
    public model = "hash-test",
    public dim = 64,
  ) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map((t) => hashVec(t, this.dim));
    return { vectors, model: this.model, dim: this.dim };
  }
}

function hashVec(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    const idx = h % dim;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  // Normalize to unit length so cosine = dot.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}
