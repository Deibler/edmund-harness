import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BgJobStore } from "../background/store.ts";
import type { Config } from "../config/config.ts";
import { loadConfig } from "../config/config.ts";
import { CronStore } from "../cron/store.ts";
import { ChatDb } from "../imessage/db.ts";
import { type SessionTier, isGuestTier, parseSessionTier } from "../security/policy.ts";
import { AddressBook } from "../sessions/address-book.ts";
import { ContactBook } from "../sessions/contacts.ts";
import { isTradingSession } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";

/**
 * Shared resources for MCP tool handlers. Constructed once per MCP server
 * startup (the server is a subprocess spawned per `claude -p` run, so
 * construction is cheap and lifetime is bounded).
 */
export type ToolContext = {
  config: Config;
  cron: CronStore;
  chatDb: ChatDb;
  contacts: ContactBook;
  sessionKey: string;
  /** The chat.guid values that belong to this session (1 for groups, N for DMs). */
  chatGuids: string[];
  /** Per-session sandbox root. All generated media goes under subdirs here. */
  sandboxPath: string;
  /** Absolute path to the harness data dir. Used for pending-queue and cron store. */
  dataDir: string;
  /** Store for lightweight background tool jobs (async CF calls, etc.). */
  bgJobs: BgJobStore;
  /** Guest-access tier of this session's sender (EDMUND_SESSION_TIER), or
   *  null for the full operator loadout. When set, assembleCoreTools simply
   *  does not register the excluded tool families — the reduction is
   *  structural, not prompt-enforced. */
  guestTier: "keyed-guest" | "vouched" | null;
  /** The full tier (operator, contact, or a guest tier). Contact sessions
   *  lose the tools that reach other people or the global memory; see
   *  src/security/policy.ts and assembleCoreTools. */
  sessionTier: SessionTier;
  /** Trading subsystem stores — present only for trading sessions. */
};

export function loadToolContext(): ToolContext {
  const configPath = process.env.EDMUND_CONFIG_PATH ?? "./config.toml";
  const config = loadConfig(configPath);
  // There is no transport to choose any more. Tool-driven sends and the
  // daemon's own replies both go through the daemon's single bridge — these
  // reach it over its control socket — so they cannot pick different paths.
  // Two processes disagreeing about the transport is what made tool sends
  // double while the daemon was pinned elsewhere.
  const sessionKey = process.env.EDMUND_SESSION_KEY ?? "";
  if (!sessionKey) throw new Error("EDMUND_SESSION_KEY env var missing");
  const sandboxPath = process.env.EDMUND_SANDBOX_PATH ?? "";
  if (!sandboxPath) throw new Error("EDMUND_SANDBOX_PATH env var missing");
  mkdirSync(sandboxPath, { recursive: true });

  // The MCP server runs with cwd=sandbox, so `config.paths.data_dir` (a
  // relative path like "./data") resolves inside the sandbox — a ghost DB
  // the daemon never reads. The daemon exposes the real absolute path via
  // EDMUND_DATA_DIR; use it when present. Without this, every reminder /
  // poke / cron insert from the model's tools lands in a throwaway file
  // and the scheduler in the daemon never sees it.
  const dataDir = process.env.EDMUND_DATA_DIR ?? config.paths.data_dir;

  const chatDb = new ChatDb(config.paths.chat_db);
  const addressBook = new AddressBook();
  const contacts = new ContactBook(config.contacts, addressBook);
  const chatGuids = chatGuidsForSession(sessionKey, chatDb, contacts);

  const sessionTier = parseSessionTier(process.env.EDMUND_SESSION_TIER);
  const guestTier = isGuestTier(sessionTier) ? sessionTier : null;

  return {
    config,
    cron: new CronStore(dataDir),
    chatDb,
    contacts,
    sessionKey,
    chatGuids,
    sandboxPath,
    dataDir,
    bgJobs: new BgJobStore(dataDir),
    guestTier,
    sessionTier,
  };
}
