import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IDEATION_ID, IdeationStore, ideationsDir } from "./store.ts";

/**
 * What the portal's Ideas tab shows, and what "Erase everything" removes.
 * Read only when a page was ever built on this machine: without
 * ideations.db there is nothing to show and nothing is created.
 */

export type PortalIdeas = {
  /** Interests the last ideator pass confirmed, most days first. */
  threads: Array<{ label: string; days: number; lastSeenMs: number }>;
  /** Published pages, newest first. */
  pages: Array<{
    title: string;
    pitch: string;
    thread: string;
    url: string;
    thumbUrl: string;
    readyMs: number;
    days: number;
  }>;
};

const EMPTY: PortalIdeas = { threads: [], pages: [] };

export function portalIdeas(dataDir: string, sessionKey: string): PortalIdeas {
  if (!existsSync(join(dataDir, "ideations.db"))) return EMPTY;
  const store = new IdeationStore(dataDir);
  try {
    const threads = store
      .threads(sessionKey)
      .filter((t) => t.days.length >= 2)
      .sort((a, b) => b.days.length - a.days.length || b.lastSeenMs - a.lastSeenMs)
      .slice(0, 8)
      .map((t) => ({ label: t.label, days: t.days.length, lastSeenMs: t.lastSeenMs }));
    const pages = store
      .listForSession(sessionKey)
      .filter((i) => i.status === "ready" && i.url && i.readyMs)
      .map((i) => ({
        title: i.title,
        pitch: i.pitch,
        thread: i.thread,
        url: i.url as string,
        thumbUrl: `${i.url}thumb.jpg`,
        readyMs: i.readyMs as number,
        days: i.days.length,
      }));
    return { threads, pages };
  } finally {
    store.close();
  }
}

/** Delete every page, run and thread kept for this person. Returns pages removed. */
export function eraseIdeations(dataDir: string, sessionKey: string): number {
  if (!existsSync(join(dataDir, "ideations.db"))) return 0;
  const store = new IdeationStore(dataDir);
  try {
    const rows = store.listForSession(sessionKey);
    for (const r of rows) {
      if (IDEATION_ID.test(r.id))
        rmSync(join(ideationsDir(dataDir), r.id), { recursive: true, force: true });
    }
    store.db.transaction(() => {
      store.db.query("DELETE FROM ideations WHERE session_key = ?").run(sessionKey);
      store.db.query("DELETE FROM ideator_runs WHERE session_key = ?").run(sessionKey);
      store.db.query("DELETE FROM interest_threads WHERE session_key = ?").run(sessionKey);
    })();
    return rows.length;
  } finally {
    store.close();
  }
}
