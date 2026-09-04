import { readdirSync, statSync } from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { sessionLabel } from "../services/labels.ts";

/**
 * People-maintainer visibility. We expose:
 *   - per-session last_maintained_at_ms (already tracked in state.db)
 *   - persona/people/*.md mtimes (the maintainer's actual output)
 *   - a kick file the daemon's PersonMaintainer can poll to force a run
 *
 * The daemon doesn't currently consume the kick file — adding that
 * is a one-line wire-up if you want to drive runs from the dashboard.
 */
export function peopleRoutes(deps: {
  state: StateStore;
  contacts: ContactBook;
  chatDb: ChatDb;
  config: Config;
  repoRoot: string;
}): Hono {
  const app = new Hono();
  const peopleDir = resolve(deps.repoRoot, "persona", "people");
  const kickPath = resolve(deps.config.paths.data_dir, "people-maintainer.kick");
  const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };

  app.get("/", (c) => {
    // Sessions with their last maintained timestamp. Reach into the
    // store's underlying DB for the bonus column not in SESSION_SELECT_COLS.
    // biome-ignore lint/suspicious/noExplicitAny: read-through to bun:sqlite
    const db = (deps.state as any).db as {
      query: (sql: string) => { all: () => unknown[] };
    };
    const rows = db
      .query(
        "SELECT session_key, last_inbound_ms, last_outbound_ms, last_maintained_at_ms FROM sessions ORDER BY last_maintained_at_ms DESC, last_inbound_ms DESC LIMIT 200",
      )
      .all() as Array<{
      session_key: string;
      last_inbound_ms: number;
      last_outbound_ms: number;
      last_maintained_at_ms: number;
    }>;
    const sessions = rows.map((r) => ({
      sessionKey: r.session_key,
      label: sessionLabel(r.session_key, labelDeps),
      lastInboundMs: r.last_inbound_ms || null,
      lastMaintainedAtMs: r.last_maintained_at_ms || null,
    }));
    const files: Array<{ name: string; bytes: number; mtimeMs: number }> = [];
    if (existsSync(peopleDir)) {
      for (const f of readdirSync(peopleDir)) {
        if (!f.endsWith(".md")) continue;
        try {
          const st = statSync(join(peopleDir, f));
          files.push({ name: f, bytes: st.size, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return c.json({
      sessions,
      files,
      config: deps.config.people_maintainer,
      peopleDir,
      kickQueued: existsSync(kickPath),
    });
  });

  app.post("/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { sessionKey?: string };
    writeFileSync(
      kickPath,
      JSON.stringify({ at: Date.now(), sessionKey: body.sessionKey ?? null }),
    );
    return c.json({ queued: true });
  });

  return app;
}
