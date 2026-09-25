import { entryToInbound, parsePendingLine, toPendingEntry } from "../bridge/session-queue.ts";
import type { Deps } from "../channels/deps.ts";
import { handleBatch, shouldAccept } from "../channels/turn.ts";
import type { TurnOpts } from "../channels/turn.ts";
import type { AddressChecker } from "../gating/address-check.ts";
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
 * Returns as soon as the backlog is read and queued: the new cursor (max rowId consumed), so the
 * caller starts the LIVE watcher right away, and a promise for the turns themselves.
 */
/**
 * Group accepted backlog messages per chat — dropping echoes / non-accepted exactly like the
 * live path. This is the heart of the no-spam guarantee: one bucket per chat → one turn per chat.
 */
export function groupBacklog(
  messages: InboundMessage[],
  deps: Pick<Deps, "config" | "echoes" | "contacts" | "state" | "guests"> &
    Partial<Pick<Deps, "alert" | "chatDb">>,
  /** Un-named group messages the address check woke him for, by row id. They
   *  join their chat's batch, marked, in place of the gate's refusal. */
  admitted: Map<number, InboundMessage> = new Map(),
): Map<SessionKey, InboundMessage[]> {
  const groups = new Map<SessionKey, InboundMessage[]>();
  // Same guest gate as the live watcher: backlog messages from unknown
  // senders buffer (or activate) exactly as they would have live, so a key
  // presented during downtime still opens the conversation on boot.
  const guestGate = deps.guests ? guestGateFor(deps.guests, deps.alert ?? null) : undefined;
  for (const backlogMsg of messages) {
    let msg = backlogMsg;
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
    if (!shouldAccept(msg, deps.config, deps.echoes, guestGate)) {
      const woken = admitted.get(msg.rowId);
      if (!woken) continue;
      msg = woken;
    }
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

/**
 * The backlog's batches: un-named group messages go through the missed-name
 * check first, and any it wakes him for join their chat's batch, marked.
 */
export async function backlogGroups(
  messages: InboundMessage[],
  deps: Parameters<typeof groupBacklog>[1],
  addressChecker?: AddressChecker,
): Promise<Map<SessionKey, InboundMessage[]>> {
  const admitted = new Map<number, InboundMessage>();
  if (addressChecker) {
    await Promise.all(
      messages.map(async (m) => {
        const woken = await addressChecker.admit(m);
        if (woken) admitted.set(m.rowId, woken);
      }),
    );
  }
  return groupBacklog(messages, deps, admitted);
}

/** What boot catch-up hands the daemon. The live watcher starts from `cursor`
 *  as soon as the backlog has been read, without waiting for any catch-up turn:
 *  on 2026-09-24 waiting for them kept every chat silent for 87 minutes behind
 *  two long turns in one DM. */
export type CatchUp = {
  /** Where the live watcher starts. Every backlog row at or below it is
   *  either in a catch-up batch (with a durable ack) or was refused. */
  cursor: number;
  /** Folds a live message into its chat's catch-up batch while that batch is
   *  still waiting to start, so the chat is answered once and in order. False
   *  when the chat has no waiting batch; route the message as usual then. */
  absorb(key: SessionKey, msg: InboundMessage): boolean;
  /** Settles when every catch-up turn has finished. Never rejects. */
  drained: Promise<void>;
};

export async function runCatchUp(params: {
  deps: Deps;
  locks: SessionLocks;
  startCursor: number;
  concurrency: number;
  /** The live watcher's missed-name check, applied to the backlog too, so an
   *  un-named group message that arrived while the daemon was down gets the
   *  same check as one that arrives live. */
  addressChecker?: AddressChecker;
  /** Test seams: the turn runner and the chat.db backlog read. */
  handle?: (key: SessionKey, batch: InboundMessage[], opts?: TurnOpts) => Promise<void>;
  read?: (startCursor: number) => { messages: InboundMessage[]; maxRowId: number };
}): Promise<CatchUp> {
  const { deps, locks, startCursor, concurrency, addressChecker } = params;
  const { config, chatDb } = deps;
  const handle = params.handle ?? ((key, batch, opts) => handleBatch(key, batch, deps, opts));
  const read = params.read ?? ((cursor) => readBacklog({ chatDb, startCursor: cursor }));

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
  }

  const { messages, maxRowId } = read(startCursor);
  const backlog =
    messages.length > 0 ? await backlogGroups(messages, deps, addressChecker) : new Map();

  // The watcher is about to start past these rows, and the cursor with it,
  // before their turns run. The same durable ack the live path writes lets a
  // crash in between replay them at the next boot; handleBatch clears the
  // acks for whatever its turn disposed of.
  if (config.behavior.durable_pending_ack) {
    for (const [key, batch] of backlog) {
      for (const msg of batch) {
        deps.state.writeInboundAck(msg.rowId, key, JSON.stringify(toPendingEntry(msg)));
      }
    }
  }

  // One batch, one turn per chat: its orphans (rows at or behind the cursor)
  // then its backlog, in row order.
  type Entry = { key: SessionKey; msgs: InboundMessage[]; orphans: number };
  const entries = new Map<SessionKey, Entry>();
  for (const [key, batch] of orphanedBySession) {
    entries.set(key, { key, msgs: [...batch], orphans: batch.length });
  }
  for (const [key, batch] of backlog as Map<SessionKey, InboundMessage[]>) {
    const entry = entries.get(key) ?? { key, msgs: [], orphans: 0 };
    entry.msgs.push(...batch);
    entries.set(key, entry);
  }
  for (const entry of entries.values()) entry.msgs.sort((a, b) => a.rowId - b.rowId);

  if (backlog.size > 0) {
    log.warn("catchup", "recovery backlog", {
      chats: backlog.size,
      messages: [...backlog.values()].reduce((n, b) => n + b.length, 0),
      concurrency,
    });
  }

  // A chat is `waiting` from now until its turn takes the session lock. Live
  // messages for it fold into its batch meanwhile (absorb), exactly as a
  // pipeline bucket collects messages until its lock comes free.
  const waiting = new Map(entries);
  const queue = [...entries.values()];
  // Bounded concurrency: at most `concurrency` chats catch up at once so a mass backlog drains
  // steadily and leaves worker-pool headroom rather than swamping the daemon on recovery.
  // A chat waits for its slot WITHOUT its session lock: the lock's inactivity
  // ceiling would release a silent holder after ~11 minutes, and a second
  // run could start on the same session.
  const runNext = async (): Promise<void> => {
    const entry = queue.shift();
    if (!entry) return;
    try {
      // Hold the session lock so a cron/recovery fire can't collide with the catch-up turn.
      await locks.withLock(entry.key, async () => {
        waiting.delete(entry.key);
        const batch = entry.msgs;
        const downtimeMs = Math.max(0, Date.now() - batch[0]!.timestampMs);
        // Always coalesce to ONE turn per chat. Only apply the "you were offline" framing when
        // the gap is meaningful (or the batch holds orphans, which by definition waited out a
        // crash) — otherwise a fast restart with a message or two would awkwardly announce a
        // 3-second outage. Small/recent backlogs just run as a normal coalesced turn.
        const meaningful =
          entry.orphans > 0 ||
          batch.length >= Math.max(2, config.behavior.auto_catchup_threshold) ||
          downtimeMs >= 300_000;
        await handle(
          entry.key,
          batch,
          meaningful ? { catchUp: { count: batch.length, downtimeMs } } : undefined,
        );
      });
    } catch (err) {
      waiting.delete(entry.key);
      log.error("catchup", "chat catch-up failed", { key: entry.key, error: String(err) });
    }
    await runNext();
  };
  const drained =
    entries.size === 0
      ? Promise.resolve()
      : Promise.all(
          Array.from({ length: Math.min(concurrency, entries.size) }, () => runNext()),
        ).then(() => log.info("catchup", "recovery backlog drained", { chats: entries.size }));

  return {
    cursor: maxRowId,
    absorb(key, msg) {
      const entry = waiting.get(key);
      if (!entry) return false;
      entry.msgs.push(msg);
      return true;
    },
    drained,
  };
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
