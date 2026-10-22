import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { normalizeHandle } from "./key.ts";

/**
 * Names Edmund has been told for numbers no address book knows.
 *
 * A group text brings in people the operator never saved. Without a name the
 * roster read `Participants: Sam, +15550100001, Jordan` and every line that
 * person wrote was tagged with a bare number, so the model had to re-derive
 * "the 0001 number is Pat" from an old message on every turn. It noted the
 * name in Pat's person file, and nothing could read it back: that file is
 * prose the model rewrites freely, and a display label must come from a keyed
 * source. This table is that source, written only by the `name_person` tool.
 *
 * **Display only.** A learned name never answers `ContactBook.displayName`,
 * which also decides SMS admission and addressing: naming someone in a group
 * must not let them in to DM Edmund. It surfaces through
 * `ContactBook.label`, always with the number attached, so it can never pass
 * for an address-book entry.
 */

/** Longest name accepted; rendered labels stay one short token run. */
const MAX_NAME_CHARS = 40;

export type LearnedNameVerdict = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Normalize and vet a name before it is stored or shown. Letters, spaces,
 * apostrophes, periods and hyphens only: a name is not a place to carry
 * instructions, numbers or markup into every envelope that renders it.
 */
export function vetLearnedName(raw: string): LearnedNameVerdict {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, reason: "empty name" };
  if (name.length > MAX_NAME_CHARS) {
    return { ok: false, reason: `longer than ${MAX_NAME_CHARS} characters` };
  }
  if (!/^\p{L}[\p{L}\p{M} '’.-]*$/u.test(name)) {
    return {
      ok: false,
      reason: "names may contain only letters, spaces, apostrophes, periods and hyphens",
    };
  }
  return { ok: true, name };
}

export class LearnedNames {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "state.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learned_names (
        handle         TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        learned_at_ms  INTEGER NOT NULL,
        session_key    TEXT
      );
    `);
  }

  /** The vetted name for a handle, or null. Re-vetted on read: a row written
   *  by an older build, or by hand, is not trusted just for being stored. */
  get(handle: string): string | null {
    const row = this.db
      .query("SELECT name FROM learned_names WHERE handle = ?")
      .get(normalizeHandle(handle)) as { name: string } | undefined;
    if (!row) return null;
    const v = vetLearnedName(row.name);
    return v.ok ? v.name : null;
  }

  set(handle: string, name: string, sessionKey: string | null, atMs = Date.now()): void {
    this.db.run(
      `INSERT INTO learned_names (handle, name, learned_at_ms, session_key)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         name = excluded.name,
         learned_at_ms = excluded.learned_at_ms,
         session_key = excluded.session_key`,
      [normalizeHandle(handle), name, atMs, sessionKey],
    );
  }

  forget(handle: string): boolean {
    return (
      this.db.run("DELETE FROM learned_names WHERE handle = ?", [normalizeHandle(handle)]).changes >
      0
    );
  }

  close(): void {
    this.db.close();
  }
}
