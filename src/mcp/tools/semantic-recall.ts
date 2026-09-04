/**
 * semantic_search MCP tool — paraphrase-tolerant recall over the
 * indexed message corpus + person files (live + archive), sandbox
 * artifacts, and episodic summaries. Complements `search_history`
 * (substring/lexical, this-chat only). Hybrid under the hood: dense
 * cosine fused with BM25 via RRF, so exact names/numbers rank too.
 *
 * Cross-boundary rule: the default scope is the current chat. Crossing
 * to other chats / people requires an explicit `scope` argument; the
 * persona is taught that other people's messages are not surface-able
 * in this conversation, so the model is the gatekeeper.
 */

import { resolve } from "node:path";
import { z } from "zod";
import { type EmbedProvider, embedQuery, makeProvider } from "../../memory/embed-provider.ts";
import { type SearchScope, VectorStore, normalize } from "../../memory/vector-store.ts";
import type { SessionTier } from "../../security/policy.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const ScopeArg = z
  .enum(["this-chat", "global", "artifacts", "summaries"])
  .or(z.string().startsWith("person:"));

const Input = z.object({
  query: z.string().min(1).describe("Natural-language query — paraphrase OK."),
  scope: ScopeArg.optional().describe(
    "Search scope. Default 'this-chat' (messages, this person's archived history, sandbox artifacts, episode summaries). 'global' crosses chats (USE SPARINGLY — cross-boundary rule applies; never surface another person's message to a third party). 'person:<handle>' restricts to one sender across chats. 'artifacts' = sandbox notes/files only. 'summaries' = episodic recaps only.",
  ),
  since: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Lower bound (ISO date or unix ms)."),
  until: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Upper bound (ISO date or unix ms). Combine with `since` to answer 'what did we discuss in March' style time-scoped questions.",
    ),
  limit: z.number().int().positive().max(50).default(10),
  min_score: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .describe("Minimum cosine score (0..1). Defaults to a low threshold."),
});

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

function parseTime(v: string | number | undefined): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function resolveScope(
  raw: string | undefined,
  chatGuids: string[],
  tier: SessionTier = "operator",
): SearchScope | { error: string } {
  // Crossing chats is an operator capability. For a contact session the
  // cross-boundary rule is enforced here rather than asked for in the
  // description: the scope simply does not resolve.
  if (
    tier !== "operator" &&
    raw &&
    raw !== "this-chat" &&
    raw !== "artifacts" &&
    raw !== "summaries"
  ) {
    return { error: `scope '${raw}' is not available in this session; use this-chat` };
  }
  if (!raw || raw === "this-chat") {
    if (chatGuids.length === 0) {
      return { error: "this-chat scope but no chat guid for this session" };
    }
    // For multi-guid DMs (alias handles), pick the first; search() will
    // accept just one chat_guid. Models almost always want one chat.
    return { kind: "this-chat", chatGuid: chatGuids[0]! };
  }
  if (raw === "global") return { kind: "global" };
  // Pre-2026-07-28 this mapped to person-file — an outright mislabel
  // that made the artifacts corpus unreachable from this tool.
  if (raw === "artifacts") return { kind: "kind", rowKind: "artifact" };
  if (raw === "summaries") return { kind: "kind", rowKind: "summary" };
  if (raw.startsWith("person:")) {
    return { kind: "person", sender: raw.slice("person:".length) };
  }
  return { error: `unknown scope: ${raw}` };
}

// Module singletons: the MCP server process handles many tool calls per
// session; rebuilding the transformers pipeline (model load) and the
// store cache per call was pure waste.
let providerSingleton: EmbedProvider | null = null;
let storeSingleton: VectorStore | null = null;

export function semanticRecallTools(ctx: ToolContext): ToolDef[] {
  const cfg = ctx.config.memory_recall;
  if (!cfg.enabled) return [];

  const getProvider = (): EmbedProvider => {
    if (!providerSingleton) {
      providerSingleton = makeProvider({
        provider: cfg.provider,
        model: cfg.model,
        dim: cfg.dim,
        ollamaEndpoint: cfg.ollama_endpoint,
        openaiKey: ctx.config.keys.openai,
      });
    }
    return providerSingleton;
  };
  const getStore = (): VectorStore => {
    if (!storeSingleton) {
      storeSingleton = new VectorStore(resolve(ctx.dataDir, cfg.index_db));
    }
    return storeSingleton;
  };

  return [
    {
      name: "semantic_search",
      description:
        "Paraphrase-tolerant recall over the indexed memory corpus: messages, this person's archived profile history, sandbox artifacts, and episode summaries. Hybrid (meaning + exact-term) search — use it when `search_history` substring-search would miss the match, when the user references something from way back, or with since/until for time-scoped questions ('what did we talk about in March'). Default scope is the current chat; `scope='global'` crosses chats but you must respect the cross-boundary rule (never surface message X said in DM A back to DM B). Returns ref + ts + sender + score + a short text preview per hit.",
      inputSchema: Input,
      handler: async (args) => {
        const scope = resolveScope(args.scope, ctx.chatGuids, ctx.sessionTier);
        if ("error" in scope) return text(scope.error, true);

        let qvec: Float32Array;
        try {
          const result = await embedQuery(getProvider(), [args.query]);
          qvec = normalize(result.vectors[0]!);
        } catch (e) {
          return text(`embed failed: ${(e as Error).message}`, true);
        }

        const store = getStore();
        const hits = store.search(qvec, {
          scope,
          queryText: args.query,
          sinceMs: parseTime(args.since),
          untilMs: parseTime(args.until),
          limit: args.limit,
          minScore: args.min_score,
        });
        if (hits.length === 0) {
          return text(`no matches (scope=${scope.kind}; corpus has ${store.count()} indexed rows)`);
        }
        const lines = hits.map((h) => {
          const who = h.sender ?? "—";
          const when = new Date(h.ts).toISOString();
          const preview = h.text.length > 180 ? `${h.text.slice(0, 180)}…` : h.text;
          return `${h.ref}  ${when}  ${who}  (${h.score.toFixed(3)}): ${preview}`;
        });
        return text(lines.join("\n"));
      },
    },
  ];
}
