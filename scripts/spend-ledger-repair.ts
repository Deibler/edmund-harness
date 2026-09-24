#!/usr/bin/env bun
/**
 * Repair spend rows booked before 2026-09-24, when a resumed conversation's
 * running total (the CLI's `total_cost_usd` for the whole model session) was
 * recorded as each turn's cost. Those rows summed to 4-11x the real spend.
 *
 *   bun scripts/spend-ledger-repair.ts            # dry run: before/after by month
 *   bun scripts/spend-ledger-repair.ts --apply    # back up spend.db, then repair
 *   ... --dir <data dir>                          # another ledger (default [paths].data_dir)
 *
 * Only subsystems that resume a chat's session are touched (turn, cron,
 * ghost-fire, guest*). Turns, cron fires and proactive fires on one chat
 * share its model session, so each chat's rows are walked together in order:
 *   - the old value becomes session_total_usd;
 *   - cost_usd becomes the rise since the chat's previous total;
 *   - the chat's first row is unknown (null): its total includes history
 *     from before the ledger (on a re-run, the chat's last repaired total
 *     is the starting point instead);
 *   - a drop to under half the previous total starts a new model session, so
 *     the total is that turn's cost; a smaller drop is a restored total that
 *     lagged after a killed process, and is unknown.
 * The history rows carry no model session id, so the split between sessions
 * is inferred; costs booked since the fix are exact. Already-repaired rows
 * (session_total_usd set) are skipped, so a second run changes nothing.
 * The daily rollup is rebuilt from the corrected rows.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { SpendLedger, localDay } from "../src/spend/ledger.ts";

const apply = process.argv.includes("--apply");
const dirFlag = process.argv.indexOf("--dir");
const dataDir = dirFlag > 0 ? process.argv[dirFlag + 1]! : loadConfig().paths.data_dir;
const path = join(dataDir, "spend.db");
// A dry run only reads. --apply opens through SpendLedger first, which adds
// the session_total_usd / model_session_id columns if this ledger predates them.
if (apply) new SpendLedger(dataDir).close();
const db = apply ? new Database(path) : new Database(path, { readonly: true });
// The daemon writes here constantly; wait out its locks rather than fail.
db.exec("PRAGMA busy_timeout = 10000");
const hasTotal = (db.query("PRAGMA table_info(turns)").all() as { name: string }[]).some(
  (c) => c.name === "session_total_usd",
);
const unrepaired = hasTotal ? "AND session_total_usd IS NULL AND model_session_id IS NULL" : "";

const RESUMED = "(subsystem IN ('turn', 'cron', 'ghost-fire') OR subsystem LIKE 'guest%')";
type Row = {
  id: number;
  ts: number;
  session_key: string;
  subsystem: string;
  cost_usd: number | null;
};
const rows = db
  .query(
    `SELECT id, ts, session_key, subsystem, cost_usd FROM turns
      WHERE ${RESUMED} ${unrepaired}
      ORDER BY session_key, id`,
  )
  .all() as Row[];

const fixes: { id: number; total: number; cost: number | null }[] = [];
// A chat's rows repaired on an earlier run, or booked since the fix, give
// its last known total, so a re-run continues the chain instead of losing
// the first row.
const knownTotal = db.query(
  `SELECT session_total_usd AS t FROM turns
    WHERE session_key = ? AND id < ? AND session_total_usd IS NOT NULL AND ${RESUMED}
    ORDER BY id DESC LIMIT 1`,
);
let prev: { key: string; total: number } | null = null;
for (const r of rows) {
  if (r.cost_usd === null) continue;
  const total = r.cost_usd;
  if (!prev || prev.key !== r.session_key) {
    const known = hasTotal ? (knownTotal.get(r.session_key, r.id) as { t: number } | null) : null;
    prev = known ? { key: r.session_key, total: known.t } : null;
  }
  let cost: number | null;
  if (!prev) cost = null;
  else if (total >= prev.total) cost = total - prev.total;
  else if (total < prev.total / 2) cost = total;
  else cost = null;
  fixes.push({ id: r.id, total, cost });
  prev = { key: r.session_key, total };
}

const monthOf = new Map(rows.map((r) => [r.id, new Date(r.ts).toISOString().slice(0, 7)]));
const before = new Map<string, number>();
const after = new Map<string, number>();
let unknown = 0;
for (const f of fixes) {
  const m = monthOf.get(f.id)!;
  before.set(m, (before.get(m) ?? 0) + f.total);
  after.set(m, (after.get(m) ?? 0) + (f.cost ?? 0));
  if (f.cost === null) unknown++;
}
console.log(`${fixes.length} rows to repair, ${unknown} of them unknown after repair`);
for (const m of [...before.keys()].sort()) {
  console.log(`${m}  booked $${before.get(m)!.toFixed(2)}  ->  $${after.get(m)!.toFixed(2)}`);
}
if (!apply) {
  console.log("\ndry run; pass --apply to back up spend.db and write the repair");
  process.exit(0);
}

const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
console.log(`\nbacked up to ${backup}`);

db.transaction(() => {
  const set = db.query("UPDATE turns SET session_total_usd = ?, cost_usd = ? WHERE id = ?");
  for (const f of fixes) set.run(f.total, f.cost, f.id);
  // Rebuild the rollup for the repaired subsystems from the corrected rows.
  const sums = new Map<string, { day: string; key: string; sub: string; cost: number }>();
  for (const r of db
    .query(`SELECT ts, session_key, subsystem, cost_usd FROM turns WHERE ${RESUMED}`)
    .all() as Row[]) {
    const day = localDay(r.ts);
    const k = `${day}|${r.session_key}|${r.subsystem}`;
    const s = sums.get(k) ?? { day, key: r.session_key, sub: r.subsystem, cost: 0 };
    s.cost += r.cost_usd ?? 0;
    sums.set(k, s);
  }
  const upd = db.query(
    "UPDATE spend_daily SET cost_usd = ? WHERE day = ? AND session_key = ? AND subsystem = ?",
  );
  for (const s of sums.values()) upd.run(s.cost, s.day, s.key, s.sub);
})();
console.log("repaired");
