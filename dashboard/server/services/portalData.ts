/**
 * Data layer for the USER self-service portal (routes/portal.ts).
 *
 * Everything here is scoped to ONE session key — the portal token grants
 * exactly one chat's data, so every function takes the sessionKey and
 * resolves paths/rows strictly inside that chat's sandbox + DB rows.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { loadPersona } from "../../../src/claude/persona.ts";
import type { Config } from "../../../src/config/config.ts";
import type { CronStore } from "../../../src/cron/store.ts";
import type { GhostPrefsStore } from "../../../src/ghost/prefs.ts";
import { ChatDb } from "../../../src/imessage/db.ts";
import { sandboxDir } from "../../../src/persona/sandbox.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { SessionKey } from "../../../src/sessions/key.ts";
import { chatIdFromKey, isGroupSession } from "../../../src/sessions/key.ts";
import { chatGuidsForSession } from "../../../src/sessions/session-scope.ts";
import type { StateStore } from "../../../src/sessions/store.ts";

// Media subdirs are surfaced on the Media tab (via mediaIndex.ts) and are
// therefore excluded from the Files/Artifacts walk to avoid double-listing.
const MEDIA_DIRS = new Set([
  "images",
  "videos",
  "voice-memos",
  "received-images",
  "received-videos",
  "received-audio",
  "received-files",
]);
// Dependency/build trees are model working state, not user files. Walking
// them made large long-running chats generate multi-megabyte portal pages
// with hundreds of thousands of hidden DOM rows (and a black screen on
// mobile Safari while it tried to parse them).
const SKIP_DIRS = new Set([
  ".resized",
  ".inline-images",
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "site-packages",
  "cadlib",
]);
const SKIP_FILES = new Set(["decisions.jsonl"]); // ghost telemetry — internal

/** Document-ish extensions shown on the Artifacts tab ("things Edmund made"). */
const ARTIFACT_EXTS = new Set([
  ".md",
  ".txt",
  ".html",
  ".pdf",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
  ".pptx",
  ".rtf",
]);

export type PortalFile = {
  relPath: string; // relative to the session sandbox dir
  name: string;
  dir: string; // parent dir relative to sandbox root ("" for top level)
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
  isArtifact: boolean;
};

export function listSessionFiles(sessionKey: SessionKey): PortalFile[] {
  const root = sandboxDir(sessionKey);
  const out: PortalFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const rel = relative(root, full);
        const top = rel.split("/")[0] ?? rel;
        if (SKIP_DIRS.has(entry) || MEDIA_DIRS.has(top)) continue;
        walk(full, depth + 1);
      } else if (st.isFile()) {
        if (SKIP_FILES.has(entry)) continue;
        const rel = relative(root, full);
        const ext = extname(entry).toLowerCase();
        out.push({
          relPath: rel,
          name: entry,
          dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
          ext,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          isArtifact: ARTIFACT_EXTS.has(ext),
        });
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Resolve a portal file request to an absolute path, refusing anything
 * outside this session's sandbox — including symlink escapes (the model has
 * full filesystem access in the sandbox and could have created one).
 */
export function resolveSessionFile(sessionKey: SessionKey, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const root = sandboxDir(sessionKey);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}/`)) return null;
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(`${realRoot}/`)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// ─── analytics ───────────────────────────────────────────────────────

export type PortalAnalytics = {
  messages: {
    total: number;
    fromYou: number;
    fromEdmund: number;
    last7: { fromYou: number; fromEdmund: number };
    last30: { fromYou: number; fromEdmund: number };
    firstMs: number | null;
    lastMs: number | null;
  };
  proactive: {
    total: number;
    engaged: number;
    ignored: number;
    lastFireMs: number | null;
  };
  schedules: { active: number; paused: number };
  media: { images: number; videos: number; audio: number; other: number };
  files: { count: number; bytes: number; artifacts: number };
};

export function sessionAnalytics(args: {
  sessionKey: SessionKey;
  chatDb: ChatDb;
  contacts: ContactBook;
  prefs: GhostPrefsStore;
  crons: CronStore;
  mediaKinds: Array<"image" | "video" | "audio" | "other">;
  files: PortalFile[];
}): PortalAnalytics {
  const { sessionKey, chatDb, contacts, prefs, crons } = args;

  const counts = (sinceMs: number | null) => {
    const guids = chatGuidsForSession(sessionKey, chatDb, contacts);
    if (guids.length === 0) return { total: 0, fromEdmund: 0, firstMs: null, lastMs: null };
    const placeholders = guids.map(() => "?").join(",");
    const sinceClause = sinceMs !== null ? "AND m.date >= ?" : "";
    const params: unknown[] = [...guids];
    if (sinceMs !== null) {
      params.push((sinceMs - ChatDb.APPLE_EPOCH_MS) * ChatDb.NS_PER_MS);
    }
    const row = chatDb
      .query<{ n: number; out: number | null; first: number | null; last: number | null }>(
        `SELECT COUNT(*) AS n, SUM(m.is_from_me) AS out,
                MIN(m.date) AS first, MAX(m.date) AS last
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE c.guid IN (${placeholders}) ${sinceClause}`,
      )
      .get(...params);
    return {
      total: row?.n ?? 0,
      fromEdmund: row?.out ?? 0,
      firstMs: row?.first ? ChatDb.appleNsToUnixMs(row.first) : null,
      lastMs: row?.last ? ChatDb.appleNsToUnixMs(row.last) : null,
    };
  };

  const now = Date.now();
  let all = {
    total: 0,
    fromEdmund: 0,
    firstMs: null as number | null,
    lastMs: null as number | null,
  };
  let d7 = { total: 0, fromEdmund: 0 };
  let d30 = { total: 0, fromEdmund: 0 };
  try {
    all = counts(null);
    d7 = counts(now - 7 * 86_400_000);
    d30 = counts(now - 30 * 86_400_000);
  } catch {
    // chat.db unreadable — show zeros rather than a broken page
  }

  const fires = prefs.recentFires(sessionKey, 500);
  const jobs = crons.listForPortal(sessionKey);
  const mediaCount = { images: 0, videos: 0, audio: 0, other: 0 };
  for (const k of args.mediaKinds) {
    if (k === "image") mediaCount.images++;
    else if (k === "video") mediaCount.videos++;
    else if (k === "audio") mediaCount.audio++;
    else mediaCount.other++;
  }

  return {
    messages: {
      total: all.total,
      fromYou: all.total - all.fromEdmund,
      fromEdmund: all.fromEdmund,
      last7: { fromYou: d7.total - d7.fromEdmund, fromEdmund: d7.fromEdmund },
      last30: { fromYou: d30.total - d30.fromEdmund, fromEdmund: d30.fromEdmund },
      firstMs: all.firstMs,
      lastMs: all.lastMs,
    },
    proactive: {
      total: fires.length,
      engaged: fires.filter((f) => f.outcome === "engaged").length,
      ignored: fires.filter((f) => f.outcome === "ignored").length,
      lastFireMs: fires[0]?.firedAtMs ?? null,
    },
    schedules: {
      active: jobs.filter((j) => j.status === "active").length,
      paused: jobs.filter((j) => j.status === "paused").length,
    },
    media: mediaCount,
    files: {
      count: args.files.length,
      bytes: args.files.reduce((s, f) => s + f.sizeBytes, 0),
      artifacts: args.files.filter((f) => f.isArtifact).length,
    },
  };
}

// ─── privacy / deletion ──────────────────────────────────────────────

export type WipeResult = { removed: number; detail: string[] };

/** Delete generated + received media (images, videos, voice memos, files). */
export function wipeMedia(sessionKey: SessionKey): WipeResult {
  const root = sandboxDir(sessionKey);
  const detail: string[] = [];
  let removed = 0;
  for (const sub of MEDIA_DIRS) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    const n = countFiles(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
      removed += n;
      if (n > 0) detail.push(`${sub}: ${n} file${n === 1 ? "" : "s"}`);
    } catch {
      detail.push(`${sub}: failed`);
    }
  }
  return { removed, detail };
}

/** Delete workspace files & artifacts — everything EXCEPT media dirs. */
export function wipeFiles(sessionKey: SessionKey): WipeResult {
  const root = sandboxDir(sessionKey);
  const detail: string[] = [];
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed: 0, detail: [] };
  }
  for (const entry of entries) {
    if (MEDIA_DIRS.has(entry)) continue;
    const full = join(root, entry);
    try {
      const st = statSync(full);
      const n = st.isDirectory() ? countFiles(full) : 1;
      rmSync(full, { recursive: true, force: true });
      removed += n;
    } catch {
      detail.push(`${entry}: failed`);
    }
  }
  if (removed > 0) detail.push(`${removed} file${removed === 1 ? "" : "s"} deleted`);
  return { removed, detail };
}

/**
 * "Erase everything" — the full per-session wipe:
 *  - whole sandbox tree (files, artifacts, media, ghost workspace)
 *  - person file (DMs only — group files are operator-managed)
 *  - proactive fire history + prefs snooze (settings themselves survive)
 *  - this chat's rows in the semantic search index (messages + artifacts)
 *  - user-visible scheduled jobs (canceled)
 *  - conversation thread reset (next message starts a fresh Claude session)
 */
export function eraseAll(args: {
  sessionKey: SessionKey;
  config: Config;
  prefs: GhostPrefsStore;
  crons: CronStore;
  state: StateStore;
  chatDb: ChatDb;
  contacts: ContactBook;
}): WipeResult {
  const { sessionKey } = args;
  const detail: string[] = [];

  // 1. Sandbox tree.
  const root = sandboxDir(sessionKey);
  if (existsSync(root)) {
    const n = countFiles(root);
    try {
      rmSync(root, { recursive: true, force: true });
      detail.push(`workspace: ${n} file${n === 1 ? "" : "s"}`);
    } catch {
      detail.push("workspace: failed");
    }
  }

  // 2. Person file (DM only).
  if (!isGroupSession(sessionKey)) {
    try {
      const person = loadPersona(null, chatIdFromKey(sessionKey)).person;
      if (person?.path && existsSync(person.path)) {
        unlinkSync(person.path);
        detail.push("personal notes file");
      }
    } catch {
      detail.push("personal notes: failed");
    }
  }

  // 3. Proactive history.
  const fires = args.prefs.deleteFires(sessionKey);
  if (fires > 0) detail.push(`${fires} proactive-message records`);
  args.prefs.setSnooze(sessionKey, null);

  // 4. Search index rows for this chat (+ any artifact rows under the sandbox).
  try {
    const vecPath = join(args.config.paths.data_dir, "vector.db");
    if (existsSync(vecPath)) {
      const db = new Database(vecPath);
      try {
        let guids: string[] = [];
        try {
          guids = chatGuidsForSession(sessionKey, args.chatDb, args.contacts);
        } catch {}
        let n = 0;
        if (guids.length > 0) {
          const ph = guids.map(() => "?").join(",");
          n += Number(
            db.query(`DELETE FROM rows WHERE chat_guid IN (${ph})`).run(...guids).changes,
          );
        }
        n += Number(db.query("DELETE FROM rows WHERE ref LIKE ?").run(`artifact:${root}%`).changes);
        if (n > 0) detail.push(`${n} search-index entries`);
      } finally {
        db.close();
      }
    }
  } catch {
    detail.push("search index: failed");
  }

  // 5. Cancel user-visible schedules.
  let canceled = 0;
  for (const job of args.crons.listForPortal(sessionKey)) {
    if (job.status === "paused") args.crons.resume(job.id); // cancel() only touches active rows
    if (args.crons.cancel(job.id)) canceled++;
  }
  if (canceled > 0) detail.push(`${canceled} scheduled task${canceled === 1 ? "" : "s"}`);

  // 6. Fresh conversation thread.
  args.state.setClaudeSessionId(sessionKey, null);
  detail.push("conversation memory reset");

  return { removed: detail.length, detail };
}

/** Reset just the running conversation thread — Edmund cold-starts next turn. */
export function resetConversation(state: StateStore, sessionKey: SessionKey): void {
  state.setClaudeSessionId(sessionKey, null);
}

function countFiles(dir: string): number {
  let n = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) n += countFiles(full);
      else if (st.isFile()) n++;
    } catch {}
  }
  return n;
}
