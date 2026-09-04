import { resolve } from "node:path";
import type { Config } from "../config/config.ts";
import { log } from "../util/log.ts";
import { type EmbedProvider, makeProvider } from "./embed-provider.ts";
import { VectorStore, normalize } from "./vector-store.ts";

/**
 * Episodic summary persistence. Recaps the harness already paid a model
 * to write (catch_me_up today; more sources later) get embedded as
 * `summary` rows instead of being thrown away after one use — a cheap
 * fact-key layer over the raw messages that auto-recall and
 * semantic_search can surface later ("what was that week about?").
 *
 * Best-effort by contract: a failed persist must never fail the recap.
 */

let provider: EmbedProvider | null = null;
let store: VectorStore | null = null;

export async function persistEpisodicSummary(args: {
  dataDir: string;
  config: Config;
  chatGuid: string;
  text: string;
  sinceMs: number;
  untilMs: number;
  /** Where the recap came from, e.g. "catch_me_up". */
  source: string;
}): Promise<void> {
  const cfg = args.config.memory_recall;
  if (!cfg.enabled) return;
  try {
    if (!provider) {
      provider = makeProvider({
        provider: cfg.provider,
        model: cfg.model,
        dim: cfg.dim,
        ollamaEndpoint: cfg.ollama_endpoint,
        openaiKey: args.config.keys.openai,
      });
    }
    if (!store) store = new VectorStore(resolve(args.dataDir, cfg.index_db));

    const from = new Date(args.sinceMs).toISOString().slice(0, 10);
    const to = new Date(args.untilMs).toISOString().slice(0, 10);
    const header = `[episode summary · ${from} → ${to} · ${args.source}]`;
    const body = `${header}\n${args.text}`.slice(0, 6_000);

    const r = await provider.embed([body]);
    if (r.vectors.length === 0) return;
    const vec = normalize(r.vectors[0]!);
    store.upsert([
      {
        ref: `summary:${args.chatGuid}:${args.untilMs}`,
        kind: "summary",
        chatGuid: args.chatGuid,
        sender: null,
        ts: args.untilMs,
        text: body,
        vec,
        model: r.model,
      },
    ]);
  } catch (err) {
    log.warn("recall", "episodic summary persist failed", {
      err: (err as Error).message,
    });
  }
}
