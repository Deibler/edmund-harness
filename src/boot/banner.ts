import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { backendForModel } from "../model/backend.ts";

/**
 * Single-line boot banner. Previously emitted 8+ lines (starting, allowlist,
 * model, send, inbound, pool, address-book, operator alerts) every restart;
 * each repeats config that already lives in config.toml. Coalesce into one
 * scannable summary; if the operator needs detail, it's in config.toml or
 * behind --debug.
 */
export function banner(
  config: Config,
  cursor: number,
  extras: { addressBookSize: number; alertsTo: string | null },
): void {
  const backend = backendForModel(config.claude.model);
  const pool =
    backend === "claude" && config.claude.pool.enabled
      ? `pool=${config.claude.pool.max_workers}@${Math.round(config.claude.pool.idle_evict_ms / 1000)}s`
      : "pool=off";
  const alerts = extras.alertsTo ? `alerts=${extras.alertsTo}` : "alerts=off";
  console.log(
    `[edmund-harness] booted cursor=${cursor} provider=${backend} model=${config.claude.model} ` +
      `${pool} ` +
      `watcher=${config.imessage_watcher.source} ` +
      `allowlist=${config.allowlist.dm.length}dm/${config.allowlist.groups.length}g contacts=${config.contacts.length} ` +
      `contacts_idx=${extras.addressBookSize} ${alerts}`,
  );
  if (process.env.DEBUG) {
    console.log(
      `[edmund-harness] debug-boot effort=${config.claude.effort} debounce=${config.behavior.debounce_ms}ms chunk=${config.behavior.chunk_chars} history=${config.behavior.history_messages}${config.behavior.history_always ? "(always)" : "(cold)"} bridge_probe=${config.imessage_send.health_interval_ms}ms/${config.imessage_send.health_timeout_ms}ms chat_db=${config.paths.chat_db}`,
    );
  }
}

/** ROWID of the newest message in chat.db. Used as the initial cursor when
 *  the daemon has no persisted cursor yet (first boot, fresh DB). */
export function highWaterMark(chatDb: ChatDb): number {
  const row = chatDb.query<{ m: number | null }>("SELECT MAX(ROWID) AS m FROM message").get();
  return row?.m ?? 0;
}

/** True if a session has been quiet long enough to count as "stale" — used
 *  to gate optional context (history-on-cold-start, recall) that's only
 *  worth paying for when the conversation is being picked up after a gap. */
export function isSessionStale(lastInboundMs: number | null, idleHours: number): boolean {
  if (!lastInboundMs || idleHours <= 0) return false;
  return Date.now() - lastInboundMs > idleHours * 3_600_000;
}
