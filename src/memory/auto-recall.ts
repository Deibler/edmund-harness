/**
 * Auto-recall: pre-fetch semantically similar past messages and inject
 * them into the envelope as a "Relevant past messages" block. Runs on
 * every inbound BEFORE the model is invoked, so the model gets the
 * context for free — no `semantic_search` tool call needed for the
 * common case.
 *
 * Failure stance: any error (provider unavailable, embed timeout, store
 * unreadable) is swallowed. Auto-recall is an enrichment — never block
 * the reply on it.
 */

import { humanAge } from "../util/clock.ts";
import { log } from "../util/log.ts";
import { type EmbedProvider, embedQuery } from "./embed-provider.ts";
import { hasRetrievableIntent } from "./query-intent.ts";
import { type SearchHit, type VectorStore, normalize } from "./vector-store.ts";

/**
 * Row kinds surfaced by auto-recall. Person/group-file chunks and
 * episodic summaries joined messages/artifacts once they gained chat
 * guids — but LIVE profile chunks are excluded post-search (the whole
 * live file is already in the session's system prompt; only `archive/`
 * chunks add anything the model can't already see).
 */
const RECALL_KINDS: Array<"message" | "artifact" | "person-file" | "summary"> = [
  "message",
  "artifact",
  "person-file",
  "summary",
];

/** How many archived self-notes may join the deep block. Deliberately small:
 *  they compete with the conversation's own history for the same slots. */
const SELF_RECALL_LIMIT = 2;

/**
 * At most one skill is ever suggested, and only on a clear match.
 *
 * The measurement that motivated this: over four months, skills were read on
 * ~5% of conversational turns, and 82% of those reads were the four skills the
 * system prompt names by hand. Nothing was discovering the rest. But the
 * failure mode of over-correcting is worse than the gap — a nudge on every
 * turn trains the model to ignore the block, and a wrong suggestion sends it
 * to read three thousand tokens of the wrong playbook.
 *
 * So: one suggestion, and a threshold well above the one used for message
 * recall. A skill description is a dense statement of purpose, so a genuine
 * match scores high; anything marginal is noise and is dropped.
 */
const SKILL_SUGGEST_LIMIT = 1;
const SKILL_MIN_SCORE = 0.55;

function isLiveProfileChunk(ref: string): boolean {
  return (
    (ref.startsWith("person:") && !ref.startsWith("person:archive/")) ||
    (ref.startsWith("group:") && !ref.startsWith("group:archive/")) ||
    // Live SOUL.md is already injected into every system prompt; recalling it
    // would spend the block on text the model is currently reading. Only the
    // ARCHIVE is worth surfacing.
    (ref.startsWith("self:") && !ref.startsWith("self:archive/"))
  );
}

export type AutoRecallOptions = {
  /** Chat guid for scope filter. */
  chatGuid: string;
  /** Master switch — see config `memory_recall.suggest_skills`, which records
   *  the measurement that keeps it off by default. */
  suggestSkills?: boolean;
  /**
   * Skills this session must never be pointed at — one owned by a
   * switched-off integration, or scoped to a different chat. Suggesting a
   * skill the model would then be refused is worse than suggesting nothing.
   */
  skillsToSkip?: Set<string>;
  /** Max hits to return in the recent block. */
  limit: number;
  /** Drop hits below this cosine score. */
  minScore: number;
  /**
   * The assistant's own trigger words. Being addressed is not a subject, so
   * "Edmund hi" has as little to look up as "hi" does.
   */
  selfNames?: readonly string[];
  /** Drop hits younger than this many ms (already in recent-thread window). */
  excludeRecentMs: number;
  /** Optional: drop any hit whose ref is in this set (avoid dupes). */
  excludeRefs?: Set<string>;
  /** Boundary in days for the recent/deep split. Hits within this window
   *  (and outside the excludeRecentMs window) go to `recent`; older hits
   *  go to `deep`. Set to 0 to disable the split (everything is "recent"). */
  deepSplitDays?: number;
  /** Max hits to return in the deep block. */
  deepLimit?: number;
  /** Recency-boost half-life (ms). Applied only to the recent block. */
  recencyHalfLifeMs?: number;
  /** Recency-boost strength. Applied only to the recent block. */
  recencyBoost?: number;
  /**
   * Group chats only: if the current inbound sender is known, run an
   * extra search scoped to that sender within this chat. Lets the
   * envelope render a "what <sender> has said before in this chat"
   * block, surfaced ABOVE the more general chat-scoped block. Pass
   * the same `sender` value the indexer uses (the raw handle, or
   * "me" for the assistant's own messages). Omit in DMs — there's
   * only one other speaker so it's redundant.
   */
  senderHandle?: string;
  /** Max hits to return in the sender-scoped block. */
  senderLimit?: number;
  /** MMR lambda passed through to VectorStore.search. */
  mmrLambda?: number;
  /** Pairwise cosine threshold for hard de-duplication of near-clones. */
  dedupThreshold?: number;
  /** Timestamp before which the model can't directly read messages
   *  (typically `last_compact_at_ms`). Hits older than this get the
   *  `outsideContextBoost` lift. */
  contextCutoffMs?: number;
  /** Multiplicative boost applied to hits older than `contextCutoffMs`. */
  outsideContextBoost?: number;
};

export type AutoRecallResult = {
  /** Group-only: hits scoped to the current sender within this chat. */
  senderInChat: SearchHit[];
  /** Hits within the last `deepSplitDays`, ordered by recency-boosted score. */
  recent: SearchHit[];
  /** Hits older than `deepSplitDays`, ordered by pure cosine. Empty when
   *  the split is disabled or no older matches survived the threshold. */
  deep: SearchHit[];
  /** Pre-formatted lines for the sender-in-chat block. */
  senderInChatLines: string[];
  /** Pre-formatted lines for the "Relevant past messages" envelope block. */
  recentLines: string[];
  /** Pre-formatted lines for the "Deep memory" envelope block. */
  deepLines: string[];
  /** Skill names worth reading for this message. At most one; often empty. */
  skillSuggestions: string[];
  /** Embed call duration (ms). 0 when no embed ran (empty query / disabled). */
  embedMs: number;
  /** Vector search duration (ms). 0 when no search ran. */
  searchMs: number;
};

const EMPTY: AutoRecallResult = {
  senderInChat: [],
  recent: [],
  deep: [],
  senderInChatLines: [],
  recentLines: [],
  deepLines: [],
  skillSuggestions: [],
  embedMs: 0,
  searchMs: 0,
};

export async function autoRecall(
  query: string,
  provider: EmbedProvider,
  store: VectorStore,
  opts: AutoRecallOptions,
): Promise<AutoRecallResult> {
  const text = query.trim();
  // A message with no subject has nothing to look up, and searching anyway is
  // what surfaced month-old context in answer to "Edmund hi". See query-intent.
  if (!hasRetrievableIntent(text, opts.selfNames)) return EMPTY;

  const embedStart = Date.now();
  let qvec: Float32Array;
  try {
    const r = await embedQuery(provider, [text]);
    if (r.vectors.length === 0) return EMPTY;
    qvec = normalize(r.vectors[0]!);
  } catch {
    return EMPTY;
  }
  const embedMs = Date.now() - embedStart;
  const searchStart = Date.now();

  const now = Date.now();
  const excludeCutoff = opts.excludeRecentMs > 0 ? now - opts.excludeRecentMs : 0;
  const splitMs =
    opts.deepSplitDays && opts.deepSplitDays > 0 ? now - opts.deepSplitDays * 86_400_000 : 0;
  const deepLimit = opts.deepLimit ?? 0;
  // Over-fetch allowance for the excludeRefs post-filter, bounded: the
  // caller's already-surfaced set can grow to hundreds over a long
  // session, and feeding that straight into the search limit makes MMR
  // selection quadratic-expensive. If every over-fetched candidate is
  // excluded, the block under-fills — fine: the strongest matches are
  // by definition already in the model's context, and padding the block
  // with weaker matches would be noise, not recall.
  const excludeAllowance = Math.min(opts.excludeRefs?.size ?? 0, 3 * opts.limit);

  // Recent block: scoped to (excludeCutoff..splitMs], recency-boosted.
  // We over-fetch then filter excludeRefs in code.
  let recent: SearchHit[];
  try {
    recent = store.search(qvec, {
      scope: { kind: "this-chat", chatGuid: opts.chatGuid },
      rowKinds: RECALL_KINDS,
      queryText: text,
      // Over-fetch so excludeRefs / senderInChat dedup post-filters
      // can't starve the block below `limit`.
      limit: opts.limit + excludeAllowance + (opts.senderLimit ?? 0),
      minScore: opts.minScore,
      // Upper bound = excludeCutoff (drop hits younger than this);
      // lower bound = splitMs (drop hits older than the deep boundary,
      // they go to the deep block instead).
      untilMs: excludeCutoff > 0 ? excludeCutoff : undefined,
      sinceMs: splitMs > 0 ? splitMs : undefined,
      recencyHalfLifeMs: opts.recencyHalfLifeMs,
      recencyBoost: opts.recencyBoost,
      nowMs: now,
      mmrLambda: opts.mmrLambda,
      dedupThreshold: opts.dedupThreshold,
      contextCutoffMs: opts.contextCutoffMs,
      outsideContextBoost: opts.outsideContextBoost,
    });
  } catch {
    return EMPTY;
  }
  recent = recent
    .filter((h) => !opts.excludeRefs?.has(h.ref) && !isLiveProfileChunk(h.ref))
    .slice(0, opts.limit);

  // Deep block: older than splitMs. Pure cosine ranking — no recency
  // boost, since by definition everything is "old". Skipped entirely
  // when deepLimit=0 or the split is disabled.
  let deep: SearchHit[] = [];
  if (deepLimit > 0 && splitMs > 0) {
    try {
      deep = store.search(qvec, {
        scope: { kind: "this-chat", chatGuid: opts.chatGuid },
        rowKinds: RECALL_KINDS,
        queryText: text,
        limit:
          deepLimit +
          Math.min(opts.excludeRefs?.size ?? 0, 3 * deepLimit) +
          (opts.senderLimit ?? 0),
        minScore: opts.minScore,
        untilMs: splitMs,
        nowMs: now,
        mmrLambda: opts.mmrLambda,
        dedupThreshold: opts.dedupThreshold,
      });
      deep = deep
        .filter((h) => !opts.excludeRefs?.has(h.ref) && !isLiveProfileChunk(h.ref))
        .slice(0, deepLimit);
    } catch {
      deep = [];
    }
  }

  // Self block: Edmund's own archived durable context. Globally scoped —
  // SOUL.md is true in every conversation, so unlike a person file it carries
  // no chat guid and the chat-scoped blocks above can never see it.
  //
  // Merged into `deep` rather than returned separately: these notes are by
  // definition older context, which is exactly what the deep block is for,
  // and folding them in keeps the result shape (and every consumer of it)
  // unchanged. Capped small so self-notes can never crowd out the
  // conversation's own history.
  if (deepLimit > 0) {
    try {
      const selfHits = store
        .search(qvec, {
          scope: { kind: "global" },
          rowKinds: ["self-file"],
          queryText: text,
          limit: SELF_RECALL_LIMIT + Math.min(opts.excludeRefs?.size ?? 0, 3 * SELF_RECALL_LIMIT),
          minScore: opts.minScore,
          nowMs: now,
          mmrLambda: opts.mmrLambda,
          dedupThreshold: opts.dedupThreshold,
        })
        .filter((h) => !opts.excludeRefs?.has(h.ref) && !isLiveProfileChunk(h.ref))
        .slice(0, SELF_RECALL_LIMIT);
      if (selfHits.length > 0) deep = [...deep, ...selfHits];
    } catch {
      // Recall degrades to chat-scoped hits; never fail a turn over it.
    }
  }

  // Sender-in-chat block (group chats): hits authored by the current
  // inbound sender within this chat. Pure cosine ranking — we don't
  // apply a recency boost here because the value of this block is
  // "what does this person tend to say about this topic", which can
  // be old. Run only when a sender handle is supplied; in DMs the
  // caller omits it because the chat-scoped block already covers the
  // single other speaker.
  let senderInChat: SearchHit[] = [];
  const senderLimit = opts.senderLimit ?? 0;
  if (opts.senderHandle && senderLimit > 0) {
    try {
      senderInChat = store.search(qvec, {
        scope: { kind: "this-chat", chatGuid: opts.chatGuid },
        senderFilter: opts.senderHandle,
        rowKinds: ["message"],
        queryText: text,
        limit: senderLimit + Math.min(opts.excludeRefs?.size ?? 0, 3 * senderLimit),
        minScore: opts.minScore,
        untilMs: excludeCutoff > 0 ? excludeCutoff : undefined,
        nowMs: now,
        mmrLambda: opts.mmrLambda,
        dedupThreshold: opts.dedupThreshold,
        contextCutoffMs: opts.contextCutoffMs,
        outsideContextBoost: opts.outsideContextBoost,
      });
      senderInChat = senderInChat
        .filter((h) => !opts.excludeRefs?.has(h.ref))
        .slice(0, senderLimit);
    } catch {
      senderInChat = [];
    }
  }

  // Avoid double-surfacing the same hit in both blocks.
  const senderRefs = new Set(senderInChat.map((h) => h.ref));
  recent = recent.filter((h) => !senderRefs.has(h.ref));
  deep = deep.filter((h) => !senderRefs.has(h.ref));

  const searchMs = Date.now() - searchStart;
  // Per-turn recall summary is folded into the unified [inbound] context
  // line in main.ts (sender/recent/deep counts + embed+search timing). The
  // standalone log line used to fire here is redundant — kept only in DEBUG.
  if (process.env.DEBUG) {
    const total = senderInChat.length + recent.length + deep.length;
    const breakdown = [
      senderInChat.length > 0 ? `${senderInChat.length} sender` : null,
      recent.length > 0 ? `${recent.length} recent` : null,
      deep.length > 0 ? `${deep.length} deep` : null,
    ]
      .filter(Boolean)
      .join(", ");
    log.debug(
      "recall",
      total === 0
        ? `no hits  (embed ${embedMs}ms, search ${searchMs}ms)`
        : `${total} hits  [${breakdown}]  (embed ${embedMs}ms, search ${searchMs}ms)`,
      opts.senderHandle ? { from: opts.senderHandle } : undefined,
    );
  }

  if (recent.length === 0 && deep.length === 0 && senderInChat.length === 0) {
    return { ...EMPTY, embedMs, searchMs };
  }

  // Skill suggestion. Reuses the query vector already embedded for this turn,
  // so the marginal cost is one index scan — the expensive half is done.
  let skillLines: string[] = [];
  if (opts.suggestSkills) {
    try {
      const hits = store.search(qvec, {
        scope: { kind: "global" },
        rowKinds: ["skill"],
        queryText: text,
        limit: SKILL_SUGGEST_LIMIT,
        minScore: Math.max(opts.minScore, SKILL_MIN_SCORE),
        nowMs: now,
      });
      skillLines = hits
        .filter((h) => !opts.skillsToSkip?.has(h.ref.replace(/^skill:/, "")))
        .slice(0, SKILL_SUGGEST_LIMIT)
        .map((h) => h.ref.replace(/^skill:/, ""));
    } catch {
      // A missing skill index must never cost a turn.
    }
  }

  return {
    senderInChat,
    recent,
    deep,
    senderInChatLines: senderInChat.map(formatLine),
    recentLines: recent.map(formatLine),
    deepLines: deep.map(formatLine),
    skillSuggestions: skillLines,
    embedMs,
    searchMs,
  };
}

function formatLine(h: SearchHit): string {
  const who = h.sender ?? "—";
  const when = isoDay(h.ts);
  // The age is stated, not left to be worked out. An absolute date alone was
  // not enough: a six-week-old item got read as Tuesday's and answered as
  // though it were live.
  const age = humanAge(h.ts);
  const preview = h.text.length > 200 ? `${h.text.slice(0, 200)}…` : h.text;
  // Show the raw cosine score so the model can judge match quality
  // without recency confusing it.
  return `  ${when} (${age}) ${who} (${h.score.toFixed(2)}): ${preview.replace(/\n+/g, " ")}`;
}

function isoDay(ms: number): string {
  // 2026-05-13 14:32 — short enough for an envelope, precise enough to
  // disambiguate.
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
