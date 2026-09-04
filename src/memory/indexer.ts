/**
 * Background indexer for semantic recall. Pulls fresh rows from
 * chat.db, embeds them in batches via the configured provider, and
 * upserts them into the vector store. Drives off two watermarks:
 *
 *   "msg.rowid"   — highest message ROWID indexed
 *   "person.mtime" — newest person-file mtime indexed
 *   "group.mtime"  — newest group-file mtime indexed
 *
 * The indexer is best-effort: any failure (embed timeout, provider
 * error) is logged and retried on the next tick. The main reply path
 * is never blocked on indexing.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractAppleTranscript } from "../imessage/apple-transcript.ts";
import type { ChatDb } from "../imessage/db.ts";
import { decodeMessageText } from "../imessage/decode.ts";
import { log } from "../util/log.ts";
import { chunkMarkdownDoc, chunkPlainText } from "./chunker.ts";
import type { EmbedProvider } from "./embed-provider.ts";
import { type AttachmentInfo, buildEnrichedText } from "./enrich.ts";
import { type IndexRow, type VectorStore, normalize } from "./vector-store.ts";

/** Bound on chunks indexed per sandbox file (~17KB of text) — coverage
 *  for long notes without letting a giant log monopolize the index. */
const MAX_ARTIFACT_CHUNKS = 12;

/** First `# H1` line of a markdown doc, else the filename sans .md. */
function docTitle(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1]! : fallback.replace(/^archive\//, "").replace(/\.md$/, "");
}

/** persona/people file names are bare handles ("15550100002.md"). Numeric
 *  names map back to +<digits> (the DM handle & guid); anything else
 *  (email slugs are lossy) gets no handle attribution. */
function handleFromPersonFileName(name: string): string | null {
  const base = name.replace(/^archive\//, "").replace(/\.md$/, "");
  return /^\d{7,15}$/.test(base) ? `+${base}` : null;
}

/**
 * Content date for a profile chunk: the NEWEST `**YYYY-MM-DD**` dated
 * bullet inside it. Profile rows used to carry the file's mtime, which
 * made every archived bullet look brand-new after each sweep/append —
 * auto-recall's exclude-recent window then hid exactly the history it
 * exists to surface. A chunk's content age is what recency filters
 * should see; mtime is only the fallback for undated prose.
 */
const BULLET_DATE_RE = /\*\*(\d{4}-\d{2}-\d{2})\*\*/g;
function newestContentDateMs(text: string): number | null {
  let max: string | null = null;
  for (const m of text.matchAll(BULLET_DATE_RE)) {
    const d = m[1]!;
    if (max === null || d > max) max = d;
  }
  if (max === null) return null;
  const ms = Date.parse(`${max}T12:00:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** `- **Chat GUID:** any;+;8262…` line every group-file scaffold carries —
 *  the same value inbound messages and auto-recall scope by. */
const GROUP_GUID_RE = /^\s*-\s*\*\*Chat GUID:\*\*\s*(\S+)/m;

/** Walk a profile dir (people or groups): live *.md plus archive/*.md
 *  (aged history moved out by the size gate). Oldest-first so a
 *  mid-batch failure's watermark rewind never strands newer files
 *  behind an already-passed watermark. */
function listProfileDir(baseDir: string): Array<{ path: string; name: string; mtime: number }> {
  const dirs = [
    { dir: baseDir, prefix: "" },
    { dir: join(baseDir, "archive"), prefix: "archive/" },
  ];
  const out: Array<{ path: string; name: string; mtime: number }> = [];
  for (const { dir, prefix } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const p = join(dir, f);
      const st = statSync(p);
      if (!st.isFile()) continue;
      out.push({ path: p, name: `${prefix}${f}`, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

export type IndexerConfig = {
  /** Max characters in indexed text (post-enrichment). */
  maxChars: number;
  /** Skip messages shorter than this (reactions, "ok", etc.). Counted on
   *  the enriched text so an attachment-only message with metadata can
   *  still index. */
  minChars: number;
  /** Batch size for the provider. */
  batchSize: number;
  /** Max rows fetched per DB tick. */
  chunkSize: number;
  /** Don't backfill messages older than this many days. 0 = no limit. */
  backfillDays: number;
  /** Root of the per-session sandbox dirs ("sandbox/"). The indexer
   *  walks each session subdir on every tick and indexes new/modified
   *  files (text-bearing only). */
  sandboxRoot?: string;
  /** Whitelist of extensions to index from sandbox dirs. Other files
   *  (binaries, archives, .resized cache, etc.) are skipped. */
  sandboxExtensions?: string[];
};

export class Indexer {
  private indexing = false;
  private personFilesDir: string | null;
  private groupFilesDir: string | null;
  /** persona/ — SOUL.md and persona/archive/SOUL.md. */
  private selfFilesDir: string | null;
  /**
   * Function that maps a sandbox dir basename (e.g. "dm_15550100001")
   * to its real iMessage `chat.guid`. Used by the sandbox-artifact
   * walker so artifact rows carry the same chat_guid value as the
   * messages in that conversation — without this, auto-recall's
   * `chat_guid = ?` filter would never return artifacts.
   *
   * Returns null when the dir name doesn't match any known session
   * (stale folder, manual mkdir). Those artifacts are skipped.
   */
  private resolveChatGuidForSandboxDir: (dirName: string) => string | null;
  /**
   * The skill catalogue. Anchored to this file rather than cwd — the daemon
   * and its tests run from different directories, and a cwd-relative lookup
   * silently indexes nothing.
   */
  private skillsDir: string = resolve(import.meta.dir, "..", "..", "skills");

  constructor(
    private chatDb: ChatDb,
    private store: VectorStore,
    private provider: EmbedProvider,
    private cfg: IndexerConfig,
    personFilesDir?: string,
    resolveChatGuidForSandboxDir?: (dirName: string) => string | null,
    groupFilesDir?: string,
    selfFilesDir?: string,
  ) {
    this.personFilesDir = personFilesDir ?? null;
    this.groupFilesDir = groupFilesDir ?? null;
    this.selfFilesDir = selfFilesDir ?? null;
    this.resolveChatGuidForSandboxDir = resolveChatGuidForSandboxDir ?? (() => null);
  }

  /**
   * One incremental pass: index any new messages since the last
   * watermark. Concurrent calls are coalesced — a second invocation
   * while the first is running returns immediately.
   */
  async tick(): Promise<{
    messages: number;
    people: number;
    artifacts: number;
    coverage: ReturnType<Indexer["coverage"]>;
  }> {
    if (this.indexing) {
      return { messages: 0, people: 0, artifacts: 0, coverage: this.coverage() };
    }
    this.indexing = true;
    try {
      const m = await this.indexMessages();
      // Group files ride the "people" counter — same row kind, same
      // profile-lore role, not worth a fourth coverage bar.
      const p =
        (await this.indexPersonFiles()) +
        (await this.indexGroupFiles()) +
        (await this.indexSelfFiles());
      await this.indexSkills();
      const a = await this.indexSandboxArtifacts();
      return { messages: m, people: p, artifacts: a, coverage: this.coverage() };
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Coverage snapshot. Three numbers:
   *
   *   - `indexedMsgs`     — rows actually stored in the vector index.
   *   - `totalInWindow`   — all chat.db messages within the backfill
   *                         window, including reactions / very short
   *                         text / system stuff the indexer filters
   *                         out. Useful as a sanity bound.
   *   - `pendingMsgs`     — messages above the watermark (i.e. not
   *                         yet *considered* by the indexer). When
   *                         this hits 0 we're caught up — anything
   *                         not indexed at that point was filtered
   *                         out, not pending.
   *
   * The previous "remaining = total - indexed" implication was
   * misleading because most of the gap is filtered noise (tapbacks,
   * "ok", empty stickers) the indexer correctly skips. `pendingMsgs`
   * is the honest "is there still work to do" signal.
   */
  coverage(): {
    indexedMsgs: number;
    totalInWindow: number;
    pendingMsgs: number;
    indexedArtifacts: number;
    totalArtifacts: number;
    indexedPeople: number;
    totalPeople: number;
  } {
    const indexedMsgs = this.store.countByKind("message");
    // Artifacts + people index as CHUNKS now; the coverage bars compare
    // against file counts, so count distinct documents, not rows.
    const indexedArtifacts = this.store.countDocsByKind("artifact");
    const indexedPeople = this.store.countDocsByKind("person-file");
    const minMs = this.cfg.backfillDays > 0 ? Date.now() - this.cfg.backfillDays * 86_400_000 : 0;
    const minAppleNs = minMs > 0 ? (minMs - 978_307_200_000) * 1_000_000 : 0;
    const total = this.chatDb
      .query<{ n: number }>(`SELECT COUNT(*) AS n FROM message m WHERE m.date >= ?`)
      .get(minAppleNs);
    const watermark = this.store.getWatermark("msg.rowid");
    const pending = this.chatDb
      .query<{ n: number }>(`SELECT COUNT(*) AS n FROM message m WHERE m.date >= ? AND m.ROWID > ?`)
      .get(minAppleNs, watermark);
    return {
      indexedMsgs,
      totalInWindow: total?.n ?? 0,
      pendingMsgs: pending?.n ?? 0,
      indexedArtifacts,
      totalArtifacts: this.countSandboxArtifacts(),
      indexedPeople,
      totalPeople: this.countPersonFiles(),
    };
  }

  /**
   * Count of text-bearing files under all session sandboxes that
   * *would* be indexed if we encountered them now (matching the
   * extension whitelist, in resolvable session dirs). This is the
   * "denominator" for the artifact coverage %.
   */
  private countSandboxArtifacts(): number {
    // Coverage denominator only — a full recursive walk over ~tens of
    // thousands of files. coverage() runs every tick (60s); recomputing
    // the denominator every 10 minutes is plenty for a progress bar and
    // drops one of the two per-minute stat-storms.
    const now = Date.now();
    if (this.artifactCountCache && now - this.artifactCountCache.computedAt < 600_000) {
      return this.artifactCountCache.value;
    }
    const value = this.countSandboxArtifactsUncached();
    this.artifactCountCache = { value, computedAt: now };
    return value;
  }

  private artifactCountCache: { value: number; computedAt: number } | null = null;

  private countSandboxArtifactsUncached(): number {
    if (!this.cfg.sandboxRoot || !existsSync(this.cfg.sandboxRoot)) return 0;
    const exts = new Set(
      (
        this.cfg.sandboxExtensions ?? [
          ".md",
          ".markdown",
          ".txt",
          ".html",
          ".htm",
          ".json",
          ".yaml",
          ".yml",
          ".csv",
          ".tsv",
          ".ts",
          ".js",
          ".py",
        ]
      ).map((e) => e.toLowerCase()),
    );
    let total = 0;
    let sessions: Dirent[];
    try {
      sessions = readdirSync(this.cfg.sandboxRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const ent of sessions) {
      if (!ent.isDirectory()) continue;
      if (!this.resolveChatGuidForSandboxDir(ent.name)) continue;
      walkArtifacts(join(this.cfg.sandboxRoot, ent.name), exts, 0, () => {
        total++;
      });
    }
    return total;
  }

  private countPersonFiles(): number {
    try {
      // Same population the person + group passes index (live + archive/
      // of each), so the people coverage bar can't exceed 100%.
      let n = 0;
      if (this.personFilesDir && existsSync(this.personFilesDir)) {
        n += this.listPersonFiles().length;
      }
      if (this.groupFilesDir && existsSync(this.groupFilesDir)) {
        n += listProfileDir(this.groupFilesDir).length;
      }
      return n;
    } catch {
      return 0;
    }
  }

  private async indexMessages(): Promise<number> {
    const watermark = this.store.getWatermark("msg.rowid");
    const minMs = this.cfg.backfillDays > 0 ? Date.now() - this.cfg.backfillDays * 86_400_000 : 0;
    const minAppleNs = minMs > 0 ? (minMs - 978_307_200_000) * 1_000_000 : 0;

    const rows = this.chatDb
      .query<{
        row_id: number;
        guid: string;
        text: string | null;
        attributed_body: Buffer | null;
        date_ns: number;
        from_me: number;
        from_handle: string | null;
        chat_guid: string;
      }>(
        `SELECT m.ROWID AS row_id, m.guid AS guid, m.text AS text,
                m.attributedBody AS attributed_body, m.date AS date_ns,
                m.is_from_me AS from_me, h.id AS from_handle,
                c.guid AS chat_guid
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.ROWID > ? AND m.date >= ?
         ORDER BY m.ROWID ASC
         LIMIT ?`,
      )
      .all(watermark, minAppleNs, this.cfg.chunkSize);

    if (rows.length === 0) return 0;

    // Bulk-fetch attachments for the whole chunk in one query (vs. per-row
    // SELECT). For each message id, we get [{filename, mime, user_info}].
    const attachmentsByMsg = this.fetchAttachments(rows.map((r) => r.row_id));

    const candidates: Array<{ row: (typeof rows)[number]; text: string }> = [];
    let maxRowId = watermark;
    let skippedAlreadyIndexed = 0;
    for (const r of rows) {
      maxRowId = Math.max(maxRowId, r.row_id);
      const decoded = decodeMessageText(r.text, r.attributed_body) ?? "";
      const atts = attachmentsByMsg.get(r.row_id) ?? [];
      const bare = buildEnrichedText({ text: decoded, attachments: atts });
      if (bare.length < this.cfg.minChars) continue;
      // Date + speaker header, embedded AND BM25-indexed: lets lexical
      // search hit "2026-03" or a handle, and shows the reading model
      // WHEN a recalled line happened (the temporal-recall lever).
      const tsMs = Math.round(r.date_ns / 1_000_000 + 978_307_200_000);
      const day = new Date(tsMs).toISOString().slice(0, 10);
      const speaker = r.from_me ? "me" : (r.from_handle ?? "them");
      const enriched = `[${day}] ${speaker}: ${bare}`.slice(0, this.cfg.maxChars);
      // Idempotency guard: if this guid is already indexed (e.g. after a
      // manual watermark reset or model change), skip re-embedding. The
      // store would `INSERT OR REPLACE` either way, but the embed call
      // is the expensive part — don't redo it for free.
      if (this.store.hasRef(`msg:${r.guid}`)) {
        skippedAlreadyIndexed++;
        continue;
      }
      candidates.push({ row: r, text: enriched });
    }
    if (skippedAlreadyIndexed > 0) {
      log.debug("recall", "skipped already-indexed", {
        count: skippedAlreadyIndexed,
      });
    }

    let indexed = 0;
    for (let i = 0; i < candidates.length; i += this.cfg.batchSize) {
      const slice = candidates.slice(i, i + this.cfg.batchSize);
      try {
        const result = await this.provider.embed(slice.map((s) => s.text));
        const indexRows: IndexRow[] = slice.map((s, idx) => {
          const vec = result.vectors[idx]!;
          normalize(vec);
          return {
            ref: `msg:${s.row.guid}`,
            kind: "message",
            chatGuid: s.row.chat_guid,
            sender: s.row.from_me ? "me" : s.row.from_handle,
            ts: Math.round(s.row.date_ns / 1_000_000 + 978_307_200_000),
            text: s.text,
            vec,
            model: result.model,
          };
        });
        this.store.upsert(indexRows);
        indexed += indexRows.length;
      } catch (e) {
        log.warn("recall", "embed batch failed; will retry next tick", {
          err: (e as Error).message,
          batch: slice.length,
        });
        // Stop on first failure so we don't advance the watermark past
        // unindexed rows.
        this.store.setWatermark("msg.rowid", slice[0]!.row.row_id - 1);
        return indexed;
      }
    }

    this.store.setWatermark("msg.rowid", maxRowId);
    return indexed;
  }

  /**
   * Bulk-fetch attachment metadata for a batch of message rowids. Avoids
   * the N+1 query a per-message lookup would do. Returns a Map keyed by
   * message_id with all attachments concatenated.
   */
  private fetchAttachments(msgIds: number[]): Map<number, AttachmentInfo[]> {
    const out = new Map<number, AttachmentInfo[]>();
    if (msgIds.length === 0) return out;
    const placeholders = msgIds.map(() => "?").join(",");
    const rows = this.chatDb
      .query<{
        message_id: number;
        filename: string | null;
        mime_type: string | null;
        user_info: Uint8Array | null;
      }>(
        `SELECT maj.message_id AS message_id,
                a.filename AS filename,
                a.mime_type AS mime_type,
                a.user_info AS user_info
         FROM message_attachment_join maj
         JOIN attachment a ON a.ROWID = maj.attachment_id
         WHERE maj.message_id IN (${placeholders})`,
      )
      .all(...msgIds);
    for (const r of rows) {
      const transcript = extractAppleTranscript(r.user_info);
      const info: AttachmentInfo = {
        filename: r.filename,
        mimeType: r.mime_type,
        transcript,
      };
      const list = out.get(r.message_id);
      if (list) list.push(info);
      else out.set(r.message_id, [info]);
    }
    return out;
  }

  /**
   * Person files (and their archive/ siblings) index as SECTION-AWARE
   * CHUNKS, not one truncated whole-file vector. Pre-chunking, a 96KB
   * profile embedded as its first 4,000 chars — >95% of the file was
   * invisible to semantic search — and `chatGuid: null` kept even that
   * sliver out of chat-scoped recall. Chunks carry a `Name > Section`
   * breadcrumb (embedded + BM25) and the DM's chat guid + handle, so
   * "relevant history with this person" surfaces per turn.
   */
  /**
   * Index SOUL.md and its archive — Edmund's notes about himself.
   *
   * Deliberately NOT scoped to a chat. A person file belongs to one
   * conversation and is scoped to that chat's guid; SOUL.md is true
   * everywhere, so its rows carry a null chat_guid and reach recall through
   * the global pass instead.
   *
   * This exists because the archiver now moves aged self-notes out of
   * SOUL.md. Before that, nothing indexed SOUL at all — archiving it without
   * this would have taken 63 bullets of durable context out of the prompt and
   * put them somewhere nothing could read. The live file is indexed too, but
   * auto-recall filters it out (isLiveProfileChunk): it is already in every
   * system prompt, so recalling it would spend the block on text the model is
   * currently reading.
   */
  private async indexSelfFiles(): Promise<number> {
    if (!this.selfFilesDir || !existsSync(this.selfFilesDir)) return 0;
    const watermark = this.store.getWatermark("self.mtime");
    // SOUL.md and its archive, plus persona/domains/*.md — what Edmund knows
    // about SUBJECTS rather than people. Both are global for the same reason:
    // they are true in every conversation, not one of them.
    const files = [
      ...listProfileDir(this.selfFilesDir).filter((f) => /(^|\/)SOUL\.md$/.test(f.name)),
      ...listProfileDir(join(this.selfFilesDir, "domains")).map((f) => ({
        ...f,
        name: `domains/${f.name}`,
      })),
    ].filter((f) => f.mtime > watermark);
    if (files.length === 0) return 0;

    let indexed = 0;
    let maxMtime = watermark;
    for (const f of files) {
      const body = readFileSync(f.path, "utf8");
      const chunks = chunkMarkdownDoc(docTitle(body, f.name), body);
      const refPrefix = `self:${f.name}#`;
      try {
        for (let i = 0; i < chunks.length; i += this.cfg.batchSize) {
          const slice = chunks.slice(i, i + this.cfg.batchSize);
          const result = await this.provider.embed(slice.map((c) => c.text));
          const rows: IndexRow[] = slice.map((c, idx) => {
            const vec = result.vectors[idx]!;
            normalize(vec);
            return {
              ref: `${refPrefix}${c.seq}`,
              kind: "self-file" as const,
              chatGuid: null,
              sender: null,
              ts: Math.round(newestContentDateMs(c.text) ?? f.mtime),
              text: c.text,
              vec,
              model: result.model,
            };
          });
          this.store.upsert(rows);
          indexed += rows.length;
        }
        const live = new Set(chunks.map((c) => `${refPrefix}${c.seq}`));
        const stale = this.store.refsWithPrefix(`self:${f.name}`).filter((r) => !live.has(r));
        this.store.deleteRefs(stale);
        maxMtime = Math.max(maxMtime, f.mtime);
      } catch (e) {
        log.warn("recall", "self-file embed failed", { err: (e as Error).message, file: f.name });
        this.store.setWatermark("self.mtime", Math.max(watermark, f.mtime - 1));
        return indexed;
      }
    }
    this.store.setWatermark("self.mtime", maxMtime);
    return indexed;
  }

  /**
   * Index the skill catalogue — one row per skill, holding the same
   * name + description line the model sees in `list_skills`.
   *
   * Deliberately the description ONLY, never the body. The question this
   * answers is "is there a method for what they just asked for", and a whole
   * SKILL.md chunked into the index would match on incidental words in its
   * examples and drown the signal. The description is the part written to say
   * when to reach for the skill.
   *
   * Re-indexed when a SKILL.md changes, and rows for deleted skills are
   * dropped — a retired skill that kept being suggested would send the model
   * to read something that is not there.
   */
  private async indexSkills(): Promise<number> {
    if (!this.skillsDir || !existsSync(this.skillsDir)) return 0;
    const entries: { name: string; text: string; mtime: number }[] = [];
    for (const name of readdirSync(this.skillsDir)) {
      if (name.startsWith(".")) continue;
      const manifest = join(this.skillsDir, name, "SKILL.md");
      try {
        if (!statSync(join(this.skillsDir, name)).isDirectory()) continue;
        if (!existsSync(manifest)) continue;
        const body = readFileSync(manifest, "utf8");
        const description = skillDescriptionLine(body);
        if (!description) continue;
        entries.push({
          name,
          text: `${name}: ${description}`,
          mtime: statSync(manifest).mtimeMs,
        });
      } catch {
        // A skill dir that vanished mid-scan is not an error.
      }
    }
    if (entries.length === 0) return 0;

    const watermark = this.store.getWatermark("skill.mtime");
    const maxMtime = entries.reduce((m, e) => Math.max(m, e.mtime), 0);
    const live = new Set(entries.map((e) => `skill:${e.name}`));
    // Drop rows for skills that no longer exist, even when nothing changed —
    // a retirement must take effect without waiting for an unrelated edit.
    const stale = this.store.refsWithPrefix("skill:").filter((r) => !live.has(r));
    if (stale.length > 0) this.store.deleteRefs(stale);
    if (maxMtime <= watermark && stale.length === 0) return 0;

    let indexed = 0;
    try {
      for (let i = 0; i < entries.length; i += this.cfg.batchSize) {
        const slice = entries.slice(i, i + this.cfg.batchSize);
        const result = await this.provider.embed(slice.map((e) => e.text));
        const rows: IndexRow[] = slice.map((e, idx) => {
          const vec = result.vectors[idx]!;
          normalize(vec);
          return {
            ref: `skill:${e.name}`,
            kind: "skill" as const,
            chatGuid: null,
            sender: null,
            ts: Math.round(e.mtime),
            text: e.text,
            vec,
            model: result.model,
          };
        });
        this.store.upsert(rows);
        indexed += rows.length;
      }
      this.store.setWatermark("skill.mtime", maxMtime);
    } catch (e) {
      log.warn("recall", "skill embed failed", { err: (e as Error).message });
    }
    return indexed;
  }

  private async indexPersonFiles(): Promise<number> {
    if (!this.personFilesDir || !existsSync(this.personFilesDir)) return 0;
    const watermark = this.store.getWatermark("person.mtime");
    const files = this.listPersonFiles().filter((f) => f.mtime > watermark);
    if (files.length === 0) return 0;

    let indexed = 0;
    let maxMtime = watermark;
    for (const f of files) {
      const body = readFileSync(f.path, "utf8");
      const title = docTitle(body, f.name);
      const chunks = chunkMarkdownDoc(title, body);
      const handle = handleFromPersonFileName(f.name);
      const chatGuid = handle ? this.dmChatGuidForHandle(handle) : null;
      const refPrefix = `person:${f.name}#`;
      try {
        for (let i = 0; i < chunks.length; i += this.cfg.batchSize) {
          const slice = chunks.slice(i, i + this.cfg.batchSize);
          const result = await this.provider.embed(slice.map((c) => c.text));
          const rows: IndexRow[] = slice.map((c, idx) => {
            const vec = result.vectors[idx]!;
            normalize(vec);
            return {
              ref: `${refPrefix}${c.seq}`,
              kind: "person-file",
              chatGuid,
              sender: handle,
              ts: Math.round(newestContentDateMs(c.text) ?? f.mtime),
              text: c.text,
              vec,
              model: result.model,
            };
          });
          this.store.upsert(rows);
          indexed += rows.length;
        }
        // A shrunk re-chunk leaves stale high-seq rows — prune them, and
        // prune the legacy whole-file row (`person:<file>` without #).
        const live = new Set(chunks.map((c) => `${refPrefix}${c.seq}`));
        const stale = this.store.refsWithPrefix(`person:${f.name}`).filter((ref) => !live.has(ref));
        this.store.deleteRefs(stale);
        maxMtime = Math.max(maxMtime, f.mtime);
      } catch (e) {
        log.warn("recall", "person-file embed failed", {
          err: (e as Error).message,
          file: f.name,
        });
        // Persist progress below the failed file so the next tick retries
        // it without re-embedding the files that already succeeded.
        this.store.setWatermark("person.mtime", Math.max(watermark, f.mtime - 1));
        return indexed;
      }
    }
    this.store.setWatermark("person.mtime", maxMtime);
    return indexed;
  }

  /** persona/people/*.md plus persona/people/archive/*.md (aged history
   *  moved out of the live files by the maintainer's size gate). */
  private listPersonFiles(): Array<{ path: string; name: string; mtime: number }> {
    return listProfileDir(this.personFilesDir!);
  }

  /**
   * Real chat.db guid for a DM handle. Person-file chunks must scope to
   * the SAME guid the chat's message rows carry — on this bridge that is
   * `any;-;+…`, and a fabricated `iMessage;-;…` guid matches no session
   * (verified live 2026-07-28: all 27k message rows were `any;…` while
   * person chunks sat unreachable under `iMessage;…`). When variants
   * exist (named-chat dupes), prefer the chat with the most messages.
   */
  private dmChatGuidForHandle(handle: string): string {
    try {
      const row = this.chatDb
        .query<{ guid: string }>(
          `SELECT c.guid AS guid FROM chat c WHERE c.guid LIKE '%;-;' || ?
           ORDER BY (SELECT COUNT(*) FROM chat_message_join j WHERE j.chat_id = c.ROWID) DESC
           LIMIT 1`,
        )
        .get(handle);
      if (row?.guid) return row.guid;
    } catch {
      // chat.db unavailable mid-tick — fall through to the convention.
    }
    return `any;-;${handle}`;
  }

  /**
   * Index persona/groups/*.md (+ archive/) the same way as person files:
   * chunked with breadcrumbs, kind "person-file", scoped to the group's
   * chat guid so auto-recall in that group can surface aged lore. The
   * guid comes from the scaffold's `**Chat GUID:**` line — for archive
   * files (which lack the scaffold) it's read from the live sibling.
   */
  private async indexGroupFiles(): Promise<number> {
    if (!this.groupFilesDir || !existsSync(this.groupFilesDir)) return 0;
    const watermark = this.store.getWatermark("group.mtime");
    const files = listProfileDir(this.groupFilesDir).filter((f) => f.mtime > watermark);
    if (files.length === 0) return 0;

    let indexed = 0;
    let maxMtime = watermark;
    for (const f of files) {
      const body = readFileSync(f.path, "utf8");
      const title = docTitle(body, f.name);
      const chunks = chunkMarkdownDoc(title, body);
      const chatGuid = this.groupChatGuid(f.name, body);
      const refPrefix = `group:${f.name}#`;
      try {
        for (let i = 0; i < chunks.length; i += this.cfg.batchSize) {
          const slice = chunks.slice(i, i + this.cfg.batchSize);
          const result = await this.provider.embed(slice.map((c) => c.text));
          const rows: IndexRow[] = slice.map((c, idx) => {
            const vec = result.vectors[idx]!;
            normalize(vec);
            return {
              ref: `${refPrefix}${c.seq}`,
              kind: "person-file",
              chatGuid,
              sender: null,
              ts: Math.round(newestContentDateMs(c.text) ?? f.mtime),
              text: c.text,
              vec,
              model: result.model,
            };
          });
          this.store.upsert(rows);
          indexed += rows.length;
        }
        const live = new Set(chunks.map((c) => `${refPrefix}${c.seq}`));
        const stale = this.store.refsWithPrefix(`group:${f.name}`).filter((ref) => !live.has(ref));
        this.store.deleteRefs(stale);
        maxMtime = Math.max(maxMtime, f.mtime);
      } catch (e) {
        log.warn("recall", "group-file embed failed", {
          err: (e as Error).message,
          file: f.name,
        });
        this.store.setWatermark("group.mtime", Math.max(watermark, f.mtime - 1));
        return indexed;
      }
    }
    this.store.setWatermark("group.mtime", maxMtime);
    return indexed;
  }

  /** Chat guid for a group file: its own `**Chat GUID:**` line, or the
   *  live sibling's for `archive/<name>.md` (archives lack the scaffold). */
  private groupChatGuid(name: string, body: string): string | null {
    const own = body.match(GROUP_GUID_RE);
    if (own) return own[1]!;
    if (name.startsWith("archive/")) {
      const livePath = join(this.groupFilesDir!, name.replace(/^archive\//, ""));
      if (existsSync(livePath)) {
        const live = readFileSync(livePath, "utf8").match(GROUP_GUID_RE);
        if (live) return live[1]!;
      }
    }
    return null;
  }

  /**
   * Walk sandbox/<session>/* dirs for text-bearing files the model has
   * produced (notes, drafts, html, markdown). New or modified files
   * (mtime > watermark) get embedded so they're recallable later
   * ("the report you wrote about X last week").
   *
   * Skips the binary-heavy buckets we already track via other paths:
   * generated `images/`, `videos/`, `voice-memos/`; the inbound copies
   * under `received-* /` (no slash-star to dodge the JSDoc closer); and
   * the resized-cache dirs (`.resized`, `.inline-images`). One row per
   * file, keyed by absolute path.
   */
  private async indexSandboxArtifacts(): Promise<number> {
    if (!this.cfg.sandboxRoot || !existsSync(this.cfg.sandboxRoot)) return 0;
    const exts = new Set(
      (
        this.cfg.sandboxExtensions ?? [
          ".md",
          ".markdown",
          ".txt",
          ".html",
          ".htm",
          ".json",
          ".yaml",
          ".yml",
          ".csv",
          ".tsv",
          ".ts",
          ".js",
          ".py",
        ]
      ).map((e) => e.toLowerCase()),
    );
    // One-time recovery (2026-07-28): the pre-v2 walk advanced the
    // watermark over EVERY candidate found while keeping only 200 per
    // tick — files dropped by the cap landed below the watermark and
    // became permanently invisible (~9.3k stranded, coverage frozen at
    // 22%). Reset once; the skip-if-current guard below makes
    // re-walking already-indexed files free (no re-embed).
    if (this.store.getWatermark("artifact.walk_v2") === 0) {
      this.store.setWatermark("artifact.mtime", 0);
      this.store.setWatermark("artifact.walk_v2", 1);
      log.info("recall", "artifact watermark reset (walk v2) — recovering capped-out files");
    }

    const watermark = this.store.getWatermark("artifact.mtime");
    let candidates: Array<{
      path: string;
      mtime: number;
      sessionDir: string;
      chatGuid: string;
    }> = [];

    const sessionDirs = readdirSync(this.cfg.sandboxRoot, { withFileTypes: true });
    let skippedUnknownDir = 0;
    for (const ent of sessionDirs) {
      if (!ent.isDirectory()) continue;
      const chatGuid = this.resolveChatGuidForSandboxDir(ent.name);
      if (!chatGuid) {
        skippedUnknownDir++;
        continue;
      }
      const sessionDir = join(this.cfg.sandboxRoot, ent.name);
      walkArtifacts(sessionDir, exts, watermark, (path, mtime) => {
        candidates.push({ path, mtime, sessionDir, chatGuid });
      });
    }
    if (skippedUnknownDir > 0) {
      log.debug("recall", "skipped sandbox dirs with no resolvable session", {
        count: skippedUnknownDir,
      });
    }
    if (candidates.length === 0) return 0;

    // OLDEST FIRST, cap per tick. Ordering is what makes the cap safe:
    // the watermark only ever advances over files this tick actually
    // processed, so everything beyond the cap stays above it and is
    // re-found next tick. (The old code took an arbitrary 200 and set
    // the watermark to the max over ALL candidates — the capped-out
    // remainder vanished forever.)
    candidates.sort((a, b) => a.mtime - b.mtime);
    if (candidates.length > 200) candidates = candidates.slice(0, 200);

    // Skip files whose current content is already indexed (chunk #0
    // carries the file's mtime + model). They still advance the
    // watermark — "processed" means "the index is current for it", not
    // "we spent an embed call on it". This is what makes the recovery
    // reset (and any future full re-walk) cheap.
    const model = this.store.currentModel();
    const toEmbed = candidates.filter((c) => {
      const row = this.store.get(`artifact:${c.path}#0`);
      return !row || row.ts !== Math.round(c.mtime) || (model !== null && row.model !== model);
    });

    // Watermark persistence: toEmbed is processed in mtime order, so at
    // any point everything strictly below the first UNPROCESSED file's
    // mtime is current in the index (embedded, or skipped-as-current).
    // On mid-run failure we persist just below that boundary — partial
    // progress survives (the message path's rewind, mirrored), and any
    // already-current files re-found at the boundary cost nothing.
    let indexed = 0;

    for (const c of toEmbed) {
      let body: string;
      try {
        body = readFileSync(c.path, "utf8");
      } catch {
        body = "";
      }
      // Chunked (was: one row truncated to maxChars — everything past
      // 4KB of a long note/log was invisible to recall). Chunk cap
      // bounds giant logs at ~17KB of indexed content per file.
      const header = `[sandbox file: ${c.path} · ${new Date(c.mtime).toISOString().slice(0, 10)}]`;
      const chunks = chunkPlainText(header, body).slice(0, MAX_ARTIFACT_CHUNKS);
      try {
        for (let i = 0; i < chunks.length; i += this.cfg.batchSize) {
          const slice = chunks.slice(i, i + this.cfg.batchSize);
          const result = await this.provider.embed(slice.map((ch) => ch.text));
          const rows: IndexRow[] = slice.map((ch, idx) => {
            const vec = result.vectors[idx]!;
            normalize(vec);
            return {
              ref: `artifact:${c.path}#${ch.seq}`,
              kind: "artifact",
              chatGuid: c.chatGuid,
              sender: "me",
              ts: Math.round(c.mtime),
              text: ch.text,
              vec,
              model: result.model,
            };
          });
          this.store.upsert(rows);
          indexed += rows.length;
        }
        // Prune chunks a shorter rewrite no longer produces, plus the
        // legacy un-suffixed whole-file row.
        const live = new Set(chunks.map((ch) => `artifact:${c.path}#${ch.seq}`));
        const stale = this.store
          .refsWithPrefix(`artifact:${c.path}`)
          .filter((ref) => !live.has(ref));
        this.store.deleteRefs(stale);
      } catch (e) {
        log.warn("recall", "artifact embed failed", {
          err: (e as Error).message,
        });
        this.store.setWatermark("artifact.mtime", Math.max(watermark, c.mtime - 1));
        return indexed;
      }
    }
    // Whole window is current — advance over every candidate this tick
    // saw (embedded + skipped-as-current alike).
    this.store.setWatermark(
      "artifact.mtime",
      Math.max(watermark, candidates[candidates.length - 1]!.mtime),
    );
    return indexed;
  }
}

function walkArtifacts(
  root: string,
  exts: Set<string>,
  watermark: number,
  visit: (path: string, mtime: number) => void,
): void {
  const SKIP_DIRS = new Set([
    ".resized",
    ".inline-images",
    "images",
    "videos",
    "voice-memos",
    "received-images",
    "received-videos",
    "received-audio",
    "received-files",
    "agents",
    "teams",
    "node_modules",
    ".git",
  ]);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".") continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(p);
        continue;
      }
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = lower.slice(dot);
      if (!exts.has(ext)) continue;
      let mtime: number;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mtime <= watermark) continue;
      visit(p, mtime);
    }
  }
}

/** The `description:` line out of a SKILL.md frontmatter block. */
function skillDescriptionLine(md: string): string | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm?.[1]) return null;
  const line = fm[1].split("\n").find((l) => l.trim().toLowerCase().startsWith("description:"));
  if (!line) return null;
  const value = line
    .replace(/^[^:]*:\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
  return value || null;
}
