import { existsSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GROUPS_DIR, PEOPLE_DIR, PERSONA_DIR } from "../claude/persona.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { unavailableIntegrationSkills } from "../integrations/host.ts";
import { autoRecall } from "../memory/auto-recall.ts";
import { type EmbedProvider, makeProvider } from "../memory/embed-provider.ts";
import { Indexer } from "../memory/indexer.ts";
import { VectorStore } from "../memory/vector-store.ts";
import { textVisibleTo, viewerForSession } from "../orchestrators/visibility.ts";
import { sandboxDir } from "../persona/sandbox.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import type { StateStore } from "../sessions/store.ts";
import { skillVisibleTo } from "../skills/author.ts";
import { readDb } from "../skills/installer.ts";
import { humanCount, progressBar } from "../util/log.ts";

/**
 * Set up the semantic-recall background indexer + auto-recall closure that
 * the turn pipeline calls per-inbound. Both pieces are gated on
 * `memory_recall.enabled` and a working provider; when disabled, the
 * indexer interval is `null` and the closure is `undefined`. Failures
 * inside the indexer are swallowed — recall is enrichment, never on the
 * critical reply path.
 */
export function wireRecall(args: {
  config: Config;
  state: StateStore;
  chatDb: ChatDb;
  contacts: ContactBook;
}): {
  interval: ReturnType<typeof setInterval> | null;
  store: VectorStore | null;
  provider: EmbedProvider | null;
  autoRecallClosure:
    | ((
        chatGuid: string,
        queryText: string,
        senderHandle?: string | null,
        sessionKey?: SessionKey,
      ) => ReturnType<typeof autoRecall>)
    | undefined;
} {
  const { config, state, chatDb, contacts } = args;
  let interval: ReturnType<typeof setInterval> | null = null;
  let store: VectorStore | null = null;
  let provider: EmbedProvider | null = null;

  if (config.memory_recall.enabled && config.memory_recall.provider !== "none") {
    store = new VectorStore(`${config.paths.data_dir}/${config.memory_recall.index_db}`);
    provider = makeProvider({
      provider: config.memory_recall.provider,
      model: config.memory_recall.model,
      dim: config.memory_recall.dim,
      ollamaEndpoint: config.memory_recall.ollama_endpoint,
      openaiKey: config.keys.openai,
    });
    // Idempotency: if the configured embedding model changed since last
    // boot, reset the indexer watermarks so the new model gets full
    // coverage. Old-model rows are PURGED (same-dim models would
    // otherwise poison searches — dim filtering can't tell them apart).
    const reset = store.resetIfModelChanged(config.memory_recall.model, config.memory_recall.dim);
    if (reset) {
      console.log(
        `[recall] embedding model changed → reset watermarks (model=${config.memory_recall.model}, dim=${config.memory_recall.dim}). Backfill will re-run with the new model.`,
      );
    }
    const localProvider = provider;
    // sandbox-dir → real chat.guid resolver for the artifact indexer.
    // Rebuilt at each call so newly-enrolled sessions are picked up
    // without a daemon restart.
    const resolveSandboxDir = (dirName: string): string | null => {
      for (const s of state.listSessions()) {
        const key = s.sessionKey as SessionKey;
        const expected = basename(sandboxDir(key));
        if (expected !== dirName) continue;
        try {
          const guids = chatGuidsForSession(key, chatDb, contacts);
          return guids[0] ?? null;
        } catch {
          return null;
        }
      }
      return null;
    };
    const indexer = new Indexer(
      chatDb,
      store,
      localProvider,
      {
        maxChars: config.memory_recall.max_chars,
        minChars: config.memory_recall.min_chars,
        batchSize: config.memory_recall.batch_size,
        chunkSize: config.memory_recall.chunk_size,
        backfillDays: config.memory_recall.backfill_days,
        sandboxRoot: "sandbox",
      },
      PEOPLE_DIR,
      resolveSandboxDir,
      GROUPS_DIR,
      // SOUL.md + persona/archive/SOUL.md. Indexed globally so the self-notes
      // the archiver moves out of the live prompt stay reachable in every
      // conversation rather than only the one they were written in.
      PERSONA_DIR,
    );
    const adaptiveThreshold = config.memory_recall.adaptive_retick_threshold;
    const kickPath = resolve(config.paths.data_dir, "recall-reindex.kick");
    let lastCoverageLogAt = 0;
    const runTick = async () => {
      try {
        // Dashboard "Kick reindex" button: touch the sentinel file. We
        // consume it by unlinking so a single press = one extra tick (the
        // current one we're already running).
        if (existsSync(kickPath)) {
          try {
            unlinkSync(kickPath);
          } catch {}
          console.log("[recall] dashboard kick received");
        }
        const r = await indexer.tick();
        if (r.messages > 0 || r.people > 0 || r.artifacts > 0) {
          const added: string[] = [];
          if (r.messages > 0) added.push(`+${r.messages} msg`);
          if (r.people > 0) added.push(`+${r.people} people`);
          if (r.artifacts > 0) added.push(`+${r.artifacts} artifacts`);
          console.log(`[recall] ${added.join(" ")}  ${formatCoverage(r.coverage)}`);
          lastCoverageLogAt = Date.now();
        } else if (Date.now() - lastCoverageLogAt > 60 * 60_000) {
          // Quiet ticks: surface coverage hourly so the operator can confirm
          // backfill is alive. Was every 10 min — produced 449 idle lines in
          // the sample window; once an hour is plenty for a "still alive"
          // signal when nothing's actually happening.
          console.log(`[recall] idle  ${formatCoverage(r.coverage)}`);
          lastCoverageLogAt = Date.now();
        }
        // Adaptive: while there's a backlog, immediately fire another
        // tick instead of waiting 60s. Capped by chunkSize per tick.
        if (adaptiveThreshold > 0 && r.messages >= adaptiveThreshold) {
          setImmediate(runTick);
        }
      } catch (err) {
        // Shutdown race: a 60s tick can be mid-flight when the daemon closes
        // the store on restart. That surfaces as "Cannot use a closed
        // database" — expected, not operator-actionable, so keep it out of
        // the error stream the triage greps.
        if (/closed database/i.test(String(err))) {
          console.warn("[recall] tick aborted mid-shutdown (database closed)");
        } else {
          console.error("[recall] tick error", err);
        }
      }
    };
    if (config.memory_recall.backfill_on_boot) {
      setTimeout(runTick, 3000);
    }
    interval = setInterval(runTick, 60_000);
    console.log(
      `[recall] indexer enabled (provider=${config.memory_recall.provider}, model=${config.memory_recall.model})`,
    );
  }

  // Auto-recall closure: pre-fetch top-N semantically similar past messages
  // on every inbound and inject them into the envelope. Only wired when the
  // recall index + provider are both ready.
  const autoRecallEnabled =
    config.memory_recall.enabled &&
    config.memory_recall.auto_recall_enabled &&
    store !== null &&
    provider !== null;
  // Refs already surfaced in an earlier envelope of the SAME context
  // window. Every envelope persists in the session transcript, so a hit
  // shown once is readable by the model for the rest of the window —
  // re-injecting it each turn just duplicates it down the transcript.
  // Keyed by the session's lastCompactAtMs: a /compact replaces those
  // envelopes with a summary, so the tracker resets and anything the
  // summary lost becomes surfaceable again. In-memory on purpose — a
  // daemon restart forgetting the set only costs one duplicate round.
  // Known edge: a turn that errors AFTER recall ran still marks its refs
  // surfaced though its envelope never reached the transcript. Rare,
  // bounded (suppression lasts until the next compact), and the model
  // can still reach those messages via semantic_search.
  /**
   * Skills this session must not be pointed at.
   *
   * Two reasons a skill can exist but be unusable here: its integration is
   * absent or switched off, or it belongs to a different conversation. The
   * skill index is global (one row per skill, no chat scope), so the filter
   * has to happen at suggestion time.
   */
  const skillsUnavailableTo = (sessionKey?: SessionKey): Set<string> => {
    const out = new Set(unavailableIntegrationSkills(config));
    if (!sessionKey) return out;
    try {
      const dbPath = resolve(config.paths.data_dir, config.skills_marketplace.installed_db);
      for (const [name, record] of Object.entries(readDb(dbPath).skills)) {
        if (!skillVisibleTo(record, sessionKey)) out.add(name);
      }
    } catch {
      // No install db yet — integration filtering alone is still correct.
    }
    return out;
  };

  const surfacedRefs = new Map<string, { compactAtMs: number; refs: Set<string> }>();
  const SURFACED_CAP = 2000;
  const autoRecallClosure = autoRecallEnabled
    ? async (
        chatGuid: string,
        queryText: string,
        senderHandle?: string | null,
        sessionKey?: SessionKey,
      ) => {
        // Outside-context boost lifts hits older than the last
        // compaction — those are messages the model can't directly read
        // anymore (only the summary survives), so surfacing them is
        // exactly when recall is most valuable.
        const lastCompactAtMs = sessionKey ? state.getLastCompactAtMs(sessionKey) : 0;
        let surfaced: { compactAtMs: number; refs: Set<string> } | undefined;
        if (sessionKey) {
          surfaced = surfacedRefs.get(sessionKey);
          if (!surfaced || surfaced.compactAtMs !== lastCompactAtMs) {
            surfaced = { compactAtMs: lastCompactAtMs, refs: new Set() };
            surfacedRefs.set(sessionKey, surfaced);
          }
        }
        const result = await autoRecall(queryText, provider!, store!, {
          chatGuid,
          limit: config.memory_recall.auto_recall_limit,
          minScore: config.memory_recall.auto_recall_min_score,
          // Being addressed by name is not a subject to search for.
          selfNames: config.identity.names,
          excludeRecentMs: config.memory_recall.auto_recall_window_hours * 3_600_000,
          excludeRefs: surfaced?.refs,
          deepSplitDays: config.memory_recall.auto_recall_deep_split_days,
          deepLimit: config.memory_recall.auto_recall_deep_limit,
          recencyHalfLifeMs: config.memory_recall.auto_recall_recency_half_life_days * 86_400_000,
          recencyBoost: config.memory_recall.auto_recall_recency_boost,
          senderHandle: senderHandle ?? undefined,
          senderLimit: config.memory_recall.auto_recall_sender_limit,
          mmrLambda: config.memory_recall.auto_recall_mmr_lambda,
          dedupThreshold: config.memory_recall.auto_recall_dedup_threshold,
          contextCutoffMs: lastCompactAtMs > 0 ? lastCompactAtMs : undefined,
          outsideContextBoost: config.memory_recall.auto_recall_outside_context_boost,
          // Never point the model at a skill it would then be refused: one
          // owned by a switched-off integration, or scoped to another chat.
          // A suggestion that dead-ends is worse than no suggestion.
          suggestSkills: config.memory_recall.suggest_skills,
          skillsToSkip: skillsUnavailableTo(sessionKey),
        });
        if (surfaced) {
          for (const h of [...result.senderInChat, ...result.recent, ...result.deep]) {
            surfaced.refs.add(h.ref);
          }
          // Bound per-session growth; dropping the oldest entries only
          // re-permits an occasional duplicate, never loses a memory.
          if (surfaced.refs.size > SURFACED_CAP) {
            const excess = surfaced.refs.size - SURFACED_CAP;
            let i = 0;
            for (const ref of surfaced.refs) {
              if (i++ >= excess) break;
              surfaced.refs.delete(ref);
            }
          }
        }
        // Per-orchestrator visibility: recall snippets are bare text (no
        // rowId), so apply the conservative text-level check — a snippet
        // naming a secondary never reaches another orchestrator's envelope.
        if (config.orchestrators.length > 0) {
          const viewer = sessionKey ? viewerForSession(sessionKey) : "main";
          const visible = (line: string) => textVisibleTo(line, viewer, config);
          return {
            ...result,
            senderInChatLines: result.senderInChatLines.filter(visible),
            recentLines: result.recentLines.filter(visible),
            deepLines: result.deepLines.filter(visible),
          };
        }
        return result;
      }
    : undefined;

  return { interval, store, provider, autoRecallClosure };
}

function formatCoverage(c: {
  indexedMsgs: number;
  totalInWindow: number;
  pendingMsgs: number;
  indexedArtifacts: number;
  totalArtifacts: number;
  indexedPeople: number;
  totalPeople: number;
}): string {
  // msgs: % is of CONSIDERED work (indexed + pending), not total-in-window.
  // Most of the gap to "total" is filtered noise (tapbacks, empty stickers)
  // that the indexer correctly skips — counting them as "missing" made the
  // bar permanently stuck at ~47% even with nothing left to do.
  const considered = c.indexedMsgs + c.pendingMsgs;
  const msgPct = considered > 0 ? (c.indexedMsgs / considered) * 100 : 100;
  const msgsLine =
    c.pendingMsgs === 0
      ? `msgs ${progressBar(100)} caught up · ${humanCount(c.indexedMsgs)} indexed`
      : `msgs ${progressBar(msgPct)} ${msgPct.toFixed(0)}% · ${humanCount(c.indexedMsgs)} indexed · ${humanCount(c.pendingMsgs)} pending`;

  // artifacts/people: cap at 100%. Indexed > total happens when files were
  // present at index time and later moved/deleted — the index still holds
  // the embedding (intentional, so old recalls still work), but showing
  // 144% is meaningless.
  const fmtCurrent = (kind: string, indexed: number, total: number): string => {
    if (total === 0) return `${kind} (none)`;
    if (indexed >= total) {
      return `${kind} ${progressBar(100)} all current · ${indexed} indexed`;
    }
    const pct = (indexed / total) * 100;
    return `${kind} ${progressBar(pct)} ${pct.toFixed(0)}% · ${indexed}/${total}`;
  };
  const artLine = fmtCurrent("artifacts", c.indexedArtifacts, c.totalArtifacts);
  const peopleLine = fmtCurrent("people", c.indexedPeople, c.totalPeople);
  return `${msgsLine}  |  ${artLine}  |  ${peopleLine}`;
}
