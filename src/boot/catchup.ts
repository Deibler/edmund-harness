import { entryToInbound, parsePendingLine } from "../bridge/session-queue.ts";
import type { Deps } from "../channels/deps.ts";
import { handleBatch, shouldAccept } from "../channels/turn.ts";
import { guestGateFor } from "../gating/allowlist.ts";
import { getGroupParticipants } from "../imessage/participants.ts";
import type { InboundMessage } from "../imessage/types.ts";
import { readBacklog } from "../imessage/watcher.ts";
import type { TradingGateFn } from "../integrations/contracts.ts";
import { integrationExportSync } from "../integrations/optional.ts";
import { sessionKeyFor, tradingKeyFor } from "../sessions/key.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";

/**
 * Boot recovery catch-up.
 *
 * When the daemon was down, the chat.db backlog (everything since the cursor) would otherwise be
 * replayed message-by-message through the live pipeline — firing one Claude turn, and one reply,
 * per missed message. In a group chat that's a spam storm (and it overloads the worker pool).
 *
 * Instead, we read the whole backlog up front, group it per chat, and run EXACTLY ONE coalesced
 * turn per chat — flagged as a recovery catch-up so the model is told it was offline and behaves
 * like a person whose phone just powered back on: scan the flood, reply once to what still matters,
 * or stay silent. Concurrency is bounded so a large pile-up drains steadily instead of swamping.
 *
 * Returns the new cursor (max rowId consumed) so the caller can start the LIVE watcher from there.
 */
/**
 * Group accepted backlog messages per chat — dropping echoes / non-accepted exactly like the
 * live path. This is the heart of the no-spam guarantee: one bucket per chat → one turn per chat.
 */
export function groupBacklog(
  messages: InboundMessage[],
  deps: Pick<Deps, "config" | "echoes" | "contacts" | "state" | "guests"> &
    Partial<Pick<Deps, "alert" | "chatDb">>,
): Map<SessionKey, InboundMessage[]> {
  const groups = new Map<SessionKey, InboundMessage[]>();
  // Same guest gate as the live watcher: backlog messages from unknown
  // senders buffer (or activate) exactly as they would have live, so a key
  // presented during downtime still opens the conversation on boot.
  const guestGate = deps.guests ? guestGateFor(deps.guests, deps.alert ?? null) : undefined;
  for (const msg of messages) {
    // Vouching happens for registered-group traffic on this path too — a
    // group message that arrived while the daemon was down still counts as
    // co-membership. Without chatDb (test fixtures) only the sender vouches.
    if (deps.guests && deps.config.guest_access.enabled && msg.isGroup && !msg.fromMe) {
      const registered =
        deps.config.allowlist.groups.length === 0 ||
        deps.config.allowlist.groups.includes(msg.chatGuid);
      if (registered) {
        try {
          const participants = deps.chatDb ? getGroupParticipants(deps.chatDb, msg.chatGuid) : [];
          deps.guests.recordVouches(
            [msg.fromHandle, ...participants].filter(Boolean),
            msg.chatGuid,
          );
        } catch (err) {
          log.warn("catchup", "vouch recording failed", { error: (err as Error).message });
        }
      }
    }
    if (!shouldAccept(msg, deps.config, deps.echoes, guestGate)) continue;
    // Routing-aware, exactly like the live path: a "wolf …" backlog message
    // goes to the trading session, everything else to edmund (per-message,
    // by name only — no stickiness). Record the decision so recovery agrees.
    const key =
      integrationExportSync<TradingGateFn>("trading", "index.ts", "tradingGate")?.(
        msg,
        deps.config,
        deps.state,
      )?.route === "trading"
        ? tradingKeyFor(msg.fromHandle)
        : sessionKeyFor(msg, deps.contacts);
    deps.state.recordRouting(msg.rowId, key);
    let batch = groups.get(key);
    if (!batch) {
      batch = [];
      groups.set(key, batch);
    }
    batch.push(msg);
  }
  return groups;
}

export async function runCatchUp(params: {
  deps: Deps;
  locks: SessionLocks;
  startCursor: number;
  concurrency: number;
}): Promise<number> {
  const { deps, locks, startCursor, concurrency } = params;
  const { config, chatDb, echoes, contacts } = deps;

  // --- orphaned inbound_ack replay (post-2026-07-19 crash hardening) ---
  const orphanedBySession = extractOrphanAcks({
    state: deps.state,
    staleCutoffMs: Date.now() - config.recovery.max_age_hours * 3_600_000,
    startCursor,
  });
  if (orphanedBySession.size > 0) {
    let totalOrphans = 0;
    for (const batch of orphanedBySession.values()) totalOrphans += batch.length;
    log.warn("catchup", "orphaned ack replay", {
      sessions: orphanedBySession.size,
      messages: totalOrphans,
    });
    const entries = [...orphanedBySession.entries()];
    let cursor = 0;
    const runOrphan = async (): Promise<void> => {
      const i = cursor++;
      if (i >= entries.length) return;
      const [key, batch] = entries[i]!;
      const opts = {
        catchUp: {
          count: batch.length,
          downtimeMs: Math.max(0, Date.now() - batch[0]!.timestampMs),
        },
      };
      try {
        await locks.withLock(key, () => handleBatch(key, batch, deps, opts));
      } catch (err) {
        log.error("catchup", "orphan replay failed", { key, error: String(err) });
      }
      await runOrphan();
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, entries.length) }, () => runOrphan()),
    );
  }
  // --- end orphan replay ---

  const { messages, maxRowId } = readBacklog({ chatDb, startCursor });
  if (messages.length === 0) return maxRowId;

  const groups = groupBacklog(messages, deps);
  if (groups.size === 0) return maxRowId;

  const total = [...groups.values()].reduce((n, b) => n + b.length, 0);
  log.warn("catchup", "recovery backlog", {
    chats: groups.size,
    messages: total,
    concurrency,
  });

  // Bounded concurrency: at most `concurrency` chats catch up at once so a mass backlog drains
  // steadily and leaves worker-pool headroom rather than swamping the daemon on recovery.
  const now = Date.now();
  const entries = [...groups.entries()];
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    const i = cursor++;
    if (i >= entries.length) return;
    const [key, batch] = entries[i]!;
    const downtimeMs = Math.max(0, now - batch[0]!.timestampMs);
    // Always coalesce to ONE turn per chat. Only apply the "you were offline" framing when the
    // gap is meaningful — otherwise a fast restart with a message or two would awkwardly announce
    // a 3-second outage. Small/recent backlogs just run as a normal coalesced turn.
    const meaningful =
      batch.length >= Math.max(2, config.behavior.auto_catchup_threshold) || downtimeMs >= 300_000;
    const opts = meaningful ? { catchUp: { count: batch.length, downtimeMs } } : undefined;
    try {
      // Hold the session lock so a cron/recovery fire can't collide with the catch-up turn.
      await locks.withLock(key, () => handleBatch(key, batch, deps, opts));
    } catch (err) {
      log.error("catchup", "chat catch-up failed", { key, error: String(err) });
    }
    await runNext();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => runNext()));

  log.info("catchup", "recovery backlog drained", { chats: groups.size });
  return maxRowId;
}

// -- export for testing --

/**
 * Read inbound_ack and produce {sessionKey → messages} for orphan replay,
 * cleaning up stale or unparseable rows. Separated from the async/concurrency
 * machinery so the dedup/age rules are testable.
 */
export function extractOrphanAcks(params: {
  state: StateStore;
  staleCutoffMs: number;
  startCursor: number;
}): Map<SessionKey, InboundMessage[]> {
  const { state, staleCutoffMs, startCursor } = params;
  const bySession = new Map<SessionKey, InboundMessage[]>();
  for (const ack of state.listInboundAcks()) {
    if (ack.createdMs < staleCutoffMs) {
      state.deleteInboundAck(ack.rowId);
      log.warn("catchup", "stale orphan ack dropped", {
        rowId: ack.rowId,
        session: ack.sessionKey,
        age: `${Math.round((Date.now() - ack.createdMs) / 3600_000)}h`,
      });
      continue;
    }
    const entry = parsePendingLine(ack.entryJson);
    if (!entry) {
      state.deleteInboundAck(ack.rowId);
      continue;
    }
    const msg = entryToInbound(entry);
    if (!msg) {
      state.deleteInboundAck(ack.rowId);
      continue;
    }
    // readBacklog reads rows STRICTLY AFTER startCursor, so those are
    // covered by the chat.db backlog path — dropping them here prevents
    // double-delivery. The true orphans are rows AT OR BEHIND the cursor:
    // the cursor advanced past them before the turn ran (the debounce-window
    // crash), so only the ack record can recover them.
    if (msg.rowId > startCursor) {
      state.deleteInboundAck(ack.rowId);
      continue;
    }
    const existing = bySession.get(ack.sessionKey);
    if (existing) {
      existing.push(msg);
    } else {
      bySession.set(ack.sessionKey, [msg]);
    }
  }
  return bySession;
}
