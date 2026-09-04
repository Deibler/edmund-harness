import { normalizeHandle } from "../../sessions/key.ts";
import { log } from "../../util/log.ts";
import { ChatDb } from "../db.ts";

/**
 * Post-send verification: where did the message actually land?
 *
 * IMCore's chat registry (inside imagent) intermittently routes a send into
 * the note-to-self thread while reporting success — observed repeatedly, with
 * a valid chat GUID, through a chat whose participants read correctly at send
 * time. The registry cannot be trusted to report on itself, but chat.db can:
 * our own outgoing message appears there within moments, joined to the chat
 * it really landed in.
 *
 * So every send is verified against the store. A message that landed in a
 * conversation identified by one of our own addresses, when we were not
 * deliberately messaging ourselves, is a detected misdelivery — surfaced to a
 * handler that can heal the registry and resend, instead of a recipient
 * silently never hearing back.
 */

type MisdeliveryEvent = {
  guid: string;
  /** The chat GUID or handle the send was addressed to. */
  intended: string;
  /** Where it actually landed. */
  landedChatGuid: string;
  landedIdentifier: string;
};

export type VerifyOutcome =
  | { verdict: "ok" }
  /** The store never showed the message inside the window. Absence of proof
   *  is not failure — the send is treated as good, with a warning. */
  | { verdict: "unverified" }
  | { verdict: "misdelivered"; event: MisdeliveryEvent };

type VerifyConfig = {
  chatDbPath: string;
  /** Our own addresses — config.self.handles. */
  selfHandles: string[];
  /**
   * Called once per recovery round for a send whose chat routes to our own
   * address. The daemon's handler rebuilds the registry (a Messages relaunch)
   * and answers "healed"; when a rebuild ran too recently to repeat it answers
   * "throttled", and the caller waits before resending anyway. Concurrent
   * callers join a rebuild already in flight. The send path resends under a
   * fresh idempotency key after each call.
   */
  onMisdelivery?: (event: MisdeliveryEvent) => Promise<"healed" | "throttled">;
  /**
   * Called once, only when recovery has exhausted every round and the message
   * is actually lost. A self-route that recovers is silent — the recipient got
   * their message, so there is nothing to tell the operator. This fires only
   * when there is: a message that did not go.
   */
  onUnrecovered?: (event: MisdeliveryEvent) => void;
  /** Pause between soft resend rounds. Defaults to 2500ms. Lowered in tests. */
  recoveryWaitMs?: number;
  /** Poll cadence overrides. For tests. */
  pollMs?: number;
  pollTries?: number;
};

let cfg: VerifyConfig | null = null;

/** The daemon (and hooks) opt in at boot. Unconfigured processes skip
 *  verification entirely and sends behave as before. */
export function configureSendVerification(config: VerifyConfig | null): void {
  cfg = config;
}

export function misdeliveryHandler(): VerifyConfig["onMisdelivery"] {
  return cfg?.onMisdelivery;
}

export function unrecoveredHandler(): VerifyConfig["onUnrecovered"] {
  return cfg?.onUnrecovered;
}

/** The configured soft-retry pause, or the 2.5s default. */
export function recoveryWaitMs(): number {
  return cfg?.recoveryWaitMs ?? 2_500;
}

const LANDED_SQL = `
  SELECT c.guid AS chat_guid, c.chat_identifier AS identifier
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.guid = ?
  LIMIT 1
`;

function isOwnAddress(addressOrGuid: string, selfHandles: string[]): boolean {
  // Accept either a bare handle or a DM chat GUID ("any;-;<handle>").
  const bare = normalizeHandle(addressOrGuid.replace(/^.*;-;/, ""));
  return selfHandles.some((h) => normalizeHandle(h) === bare);
}

/** Looks the message up in chat.db until it appears or the window closes. */
export async function verifyDelivery(guid: string, intended: string): Promise<VerifyOutcome> {
  if (!cfg || !guid) return { verdict: "unverified" };
  const pollMs = cfg.pollMs ?? 250;
  const tries = cfg.pollTries ?? 12;

  let chatDb: ChatDb | undefined;
  try {
    chatDb = new ChatDb(cfg.chatDbPath);
    const stmt = chatDb.query<{ chat_guid: string; identifier: string }>(LANDED_SQL);
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const row = stmt.get(guid);
      if (row) {
        const landedOwn = isOwnAddress(row.identifier, cfg.selfHandles);
        const intendedOwn = isOwnAddress(intended, cfg.selfHandles);
        if (landedOwn && !intendedOwn) {
          return {
            verdict: "misdelivered",
            event: {
              guid,
              intended,
              landedChatGuid: row.chat_guid,
              landedIdentifier: row.identifier,
            },
          };
        }
        return { verdict: "ok" };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } catch (err) {
    log.warn("send-verify", "verification unavailable, trusting the send", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { verdict: "unverified" };
  } finally {
    chatDb?.close();
  }
  log.warn("send-verify", "message never appeared in chat.db within the window", {
    guid,
    intended,
  });
  return { verdict: "unverified" };
}
