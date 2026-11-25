/**
 * Embedding provider abstraction. Two real impls (OpenAI HTTP, Ollama
 * HTTP) and a deterministic test stub. All return unit vectors of the
 * provider's reported dim — the vector store records (model, dim) on
 * insert and refuses to mix shapes.
 */

import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { EmbedLane } from "./embed-lanes.ts";
import type { EmbedReady, EmbedRequest, EmbedResponse } from "./transformers-embed-child.ts";

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
  /** Have the model loaded before a query arrives. Fire and forget. */
  warm?(): void;
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
// their own local Transformers provider, which meant one ONNX model per entry
// point. Keep exactly one provider per model/dimension in a process; its
// embedding process already serializes inference safely.
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

/** Release idle local-model processes under memory pressure. Active embedding
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

type PendingEmbed = {
  textCount: number;
  resolve: (result: EmbedResult) => void;
  reject: (error: Error) => void;
};

/** One embedding process and what has been queued for it. */
type Runner = {
  proc: Subprocess;
  /** False until the process says it is listening. Requests wait in `outbox`. */
  ready: boolean;
  outbox: EmbedRequest[];
};

/** What the daemon is told when local embedding stops working, and when it
 *  works again. */
export type EmbedHealthEvent = {
  kind: "failing" | "recovered";
  model: string;
  /** The latest error. Empty on a recovery. */
  error: string;
  failures: number;
  failingForMs: number;
};

let healthHook: ((event: EmbedHealthEvent) => void) | null = null;

/**
 * The daemon listens here so an embedder that stays broken reaches the
 * operator. Called once per outage and once when it ends. Recall treats an
 * embedding error as "nothing found" so a reply is never held up; before this
 * hook that was also the only trace, and 364 turns were answered without
 * recall across four outages (2026-10-30 to 2026-11-16) with no alert.
 */
export function setEmbedHealthHook(hook: ((event: EmbedHealthEvent) => void) | null): void {
  healthHook = hook;
}

function tellHealth(event: EmbedHealthEvent): void {
  try {
    healthHook?.(event);
  } catch {
    // Reporting must never be what breaks embedding.
  }
}

/** When failures are an outage rather than a blip: this many in a row,
 *  spanning at least this long. */
export type EmbedAlertAfter = { failures: number; ms: number };
export const EMBED_ALERT_AFTER: EmbedAlertAfter = { failures: 3, ms: 5 * 60_000 };

/**
 * Local embeddings via @huggingface/transformers (Transformers.js).
 *
 * The model lives in a process of its own (transformers-embed-child.ts, which
 * says why it is not a Worker thread). ONNX inference occupies the JavaScript
 * thread that called it; keeping that work in the daemon used to stall bridge
 * RPC and health timers for whole indexing batches. The process is started on
 * first use and keeps the model loaded between calls.
 *
 * Pooling + query prefix follow the model family (see familyFor); output is
 * L2-normalized either way.
 */
/**
 * Most texts the local model sees in one inference. ONNX keeps the memory a
 * batch needed and never gives it back: measured on bge-small, about 45 MB
 * per long text, so the indexer's 128-text batches left the daemon holding
 * 10 GB on a 16 GB Mac and pushed Messages into swap. Throughput per text is
 * the same at 4 and 16, so small costs nothing. It also bounds how long a
 * live recall query waits behind a backfill, since chunks are sent one at a
 * time and a query slots in between them.
 */
export const LOCAL_EMBED_BATCH = 8;

/**
 * Most texts one index request sends. A batch cannot be interrupted, so it is
 * how long a live query can wait. Measured 2026-10-29 on person-file chunks:
 * 41-45 ms per text at batch 1, 2, 4 and 8 alike, so a batch of 8 held the
 * worker four times as long as a batch of 2 for no gain (358 ms against
 * 87 ms idle; several times that under the daemon's load).
 */
export const INDEX_EMBED_BATCH = 2;

export class TransformersEmbedProvider implements EmbedProvider {
  /** How long an idle process keeps the model loaded. The model and its
   *  arena hold 300-650 MB, and a fresh process has its first vector out in
   *  about 140 ms (measured 2026-11-25), so releasing it quickly costs a
   *  recall a seventh of a second at most. */
  static readonly WORKER_IDLE_MS = 60_000;
  private runner: Runner | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEmbed>();
  private failures = 0;
  private failingSinceMs = 0;
  private lastError = "";
  private reported = false;

  constructor(
    public model: string,
    public dim: number,
    private readonly script: URL = new URL("./transformers-embed-child.ts", import.meta.url),
    private readonly idleMs: number = TransformersEmbedProvider.WORKER_IDLE_MS,
    private readonly alertAfter: EmbedAlertAfter = EMBED_ALERT_AFTER,
  ) {}

  private getRunner(): Runner {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.runner) return this.runner;
    const runner: Runner = { proc: null as unknown as Subprocess, ready: false, outbox: [] };
    runner.proc = Bun.spawn([process.execPath, fileURLToPath(this.script)], {
      // stdout is not inherited: inside an MCP server it is the JSON-RPC stream.
      stdio: ["ignore", "ignore", "inherit"],
      // Spelled out: left to the default, the process gets the environment
      // this one was launched with, not what it holds now.
      env: { ...process.env },
      serialization: "advanced",
      ipc: (message) => this.onMessage(runner, message as EmbedResponse | EmbedReady),
      onExit: (_proc, code, signal) =>
        this.drop(runner, new Error(`embedding process exited (${signal ?? `code ${code}`})`)),
    });
    this.runner = runner;
    return runner;
  }

  private onMessage(runner: Runner, message: EmbedResponse | EmbedReady): void {
    if (this.runner !== runner) return;
    if ("ready" in message) {
      runner.ready = true;
      for (const request of runner.outbox.splice(0)) runner.proc.send(request);
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);

    if (!message.ok) {
      call.reject(new Error(message.error));
      // A process that could not load the model is replaced, never asked
      // again: whatever broke it is not carried into the next one.
      if (message.stage === "load") this.drop(runner, new Error(message.error));
      else this.rest(runner);
      return;
    }
    this.rest(runner);
    if (message.dim <= 0 || message.data.length !== call.textCount * message.dim) {
      call.reject(
        new Error(
          `embedding process returned ${message.data.length} values for ` +
            `${call.textCount} texts at dim ${message.dim}`,
        ),
      );
      return;
    }
    const vectors: Float32Array[] = [];
    for (let i = 0; i < call.textCount; i++) {
      vectors.push(message.data.slice(i * message.dim, (i + 1) * message.dim));
    }
    call.resolve({ vectors, model: this.model, dim: message.dim });
  }

  /** Nothing is waiting on the process: let its owner exit, and start the
   *  idle clock. */
  private rest(runner: Runner): void {
    if (this.pending.size > 0) return;
    runner.proc.unref();
    this.armIdleTermination(runner);
  }

  /** Stop using this process. Whatever still waits on it fails with `error`,
   *  and the next call starts a fresh one. */
  private drop(runner: Runner, error: Error): void {
    if (this.runner !== runner) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.runner = null;
    runner.proc.kill();
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      call.reject(error);
    }
  }

  private armIdleTermination(runner: Runner): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timer = setTimeout(() => {
      if (this.runner !== runner || this.pending.size > 0) return;
      this.idleTimer = null;
      this.runner = null;
      runner.proc.kill();
    }, this.idleMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  /** Synchronous pressure valve used by the daemon resource governor. */
  trimIdleWorker(): boolean {
    const runner = this.runner;
    if (!runner || this.pending.size > 0) return false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.runner = null;
    runner.proc.kill();
    return true;
  }

  /**
   * Load the model now if its process was released, so the recall query that
   * follows does not pay the reload. The daemon calls it as an inbound
   * message opens its debounce window, 1.5 s before recall runs. Free when a
   * process is alive; the idle release still applies afterwards.
   */
  warm(): void {
    if (this.runner) return;
    this.runChunk(["warm"], "query").catch(() => {});
  }

  /** How embedding is doing right now. Zero failures means healthy. */
  health(): { failures: number; failingSinceMs: number | null; lastError: string | null } {
    return {
      failures: this.failures,
      failingSinceMs: this.failures > 0 ? this.failingSinceMs : null,
      lastError: this.failures > 0 ? this.lastError : null,
    };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return this.run(texts, "index");
  }

  async embedQuery(texts: string[]): Promise<EmbedResult> {
    const { queryPrefix } = familyFor(this.model);
    return this.run(queryPrefix ? texts.map((t) => queryPrefix + t) : texts, "query");
  }

  private async run(texts: string[], lane: EmbedLane): Promise<EmbedResult> {
    const batch = lane === "query" ? LOCAL_EMBED_BATCH : INDEX_EMBED_BATCH;
    if (texts.length <= batch) return this.runChunk(texts, lane);
    const vectors: Float32Array[] = [];
    let dim = this.dim;
    for (let i = 0; i < texts.length; i += batch) {
      const part = await this.runChunk(texts.slice(i, i + batch), lane);
      vectors.push(...part.vectors);
      dim = part.dim;
    }
    return { vectors, model: this.model, dim };
  }

  private async runChunk(texts: string[], lane: EmbedLane): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model: this.model, dim: this.dim };
    try {
      const result = await this.send(texts, lane);
      this.noteSuccess();
      return result;
    } catch (error) {
      this.noteFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private send(texts: string[], lane: EmbedLane): Promise<EmbedResult> {
    const runner = this.getRunner();
    const id = this.nextRequestId++;
    const request: EmbedRequest = {
      id,
      model: this.model,
      pooling: familyFor(this.model).pooling,
      texts,
      lane,
    };
    return new Promise<EmbedResult>((resolve, reject) => {
      this.pending.set(id, { textCount: texts.length, resolve, reject });
      // An unresolved Promise does not keep a process alive. Hold the
      // embedding process only while calls are outstanding; an idle one is
      // free to let one-shot MCP/indexing processes exit normally.
      runner.proc.ref();
      try {
        if (runner.ready) runner.proc.send(request);
        else runner.outbox.push(request);
      } catch (error) {
        this.pending.delete(id);
        this.rest(runner);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private noteSuccess(): void {
    if (this.failures === 0) return;
    const event: EmbedHealthEvent = {
      kind: "recovered",
      model: this.model,
      error: "",
      failures: this.failures,
      failingForMs: Date.now() - this.failingSinceMs,
    };
    const wasReported = this.reported;
    this.failures = 0;
    this.failingSinceMs = 0;
    this.lastError = "";
    this.reported = false;
    if (wasReported) tellHealth(event);
  }

  private noteFailure(error: string): void {
    const now = Date.now();
    if (this.failures === 0) this.failingSinceMs = now;
    this.failures++;
    this.lastError = error;
    const failingForMs = now - this.failingSinceMs;
    if (this.reported) return;
    if (this.failures < this.alertAfter.failures || failingForMs < this.alertAfter.ms) return;
    this.reported = true;
    tellHealth({
      kind: "failing",
      model: this.model,
      error,
      failures: this.failures,
      failingForMs,
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
