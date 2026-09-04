import { Hono } from "hono";
import type { BgJobStore } from "../../../src/background/store.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { sessionLabel } from "../services/labels.ts";

/**
 * Background tool jobs (`async: true` MCP calls). Exposes the bg_jobs.db
 * rows the daemon writes from scripts/bg-runner.ts. The dashboard previously
 * had no visibility into these — they were a black box until the wake-up
 * cron fired (or didn't).
 */
export function bgJobsRoutes(deps: {
  bgJobs: BgJobStore;
  contacts: ContactBook;
  chatDb: ChatDb;
}): Hono {
  const app = new Hono();
  const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };

  app.get("/", (c) => {
    const sessionFilter = c.req.query("session");
    const statusFilter = c.req.query("status");
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));

    // No global listAll — fan out per session by scanning state. Simpler:
    // use the per-session helper for the filter case, otherwise return a
    // recent slice across all sessions via a small raw query.
    const rows = sessionFilter
      ? deps.bgJobs.listForSession(sessionFilter, limit)
      : listRecentAll(deps.bgJobs, limit);

    const filtered = statusFilter ? rows.filter((j) => j.status === statusFilter) : rows;

    return c.json({
      jobs: filtered.map((j) => ({
        id: j.id,
        sessionKey: j.sessionKey,
        label: sessionLabel(j.sessionKey, labelDeps),
        sandboxPath: j.sandboxPath,
        toolName: j.toolName,
        argsJson: j.argsJson,
        status: j.status,
        pid: j.pid,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        resultPath: j.resultPath,
        resultSummary: j.resultSummary,
        errorText: j.errorText,
        wakeFiredAt: j.wakeFiredAt,
      })),
    });
  });

  app.get("/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const j = deps.bgJobs.get(id);
    if (!j) return c.json({ error: "not found" }, 404);
    return c.json({
      job: { ...j, label: sessionLabel(j.sessionKey, labelDeps) },
    });
  });

  return app;
}

/**
 * BgJobStore doesn't expose a global "all rows" query. Reach into the
 * underlying DB via a small raw read — the store exports the Database via
 * its constructor's side effect of opening bg_jobs.db, so we go through
 * `listForSession` per known session would require a sessions list. Cheaper:
 * use a single SELECT bound against bg_jobs directly.
 *
 * We accept the layering nick to avoid threading a state-store dep in here
 * and to keep this route self-contained.
 */
function listRecentAll(store: BgJobStore, limit: number) {
  // Use the store's existing public surface by reading the DB it owns.
  // biome-ignore lint/suspicious/noExplicitAny: intentional read through the public store
  const db = (store as any).db as {
    query: (sql: string) => { all: (...a: unknown[]) => unknown[] };
  };
  const rows = db
    .query("SELECT * FROM bg_jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{
    id: string;
    session_key: string;
    sandbox_path: string;
    tool_name: string;
    args_json: string;
    status: "pending" | "running" | "done" | "failed";
    pid: number | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    result_path: string | null;
    result_summary: string | null;
    error_text: string | null;
    wake_fired_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionKey: r.session_key,
    sandboxPath: r.sandbox_path,
    toolName: r.tool_name,
    argsJson: r.args_json,
    status: r.status,
    pid: r.pid,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    resultPath: r.result_path,
    resultSummary: r.result_summary,
    errorText: r.error_text,
    wakeFiredAt: r.wake_fired_at ?? null,
  }));
}
