/**
 * The chat on the household site.
 *
 * One thread per person, not per household: two people sharing a kitchen do
 * not share a conversation. Each message records the page and subject it was
 * sent from, which is what gives a question like "how do I cut this" its
 * meaning. Stored as one append-only JSONL per person.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso } from "./store.ts";

export type ChatTurn = {
  /** "them" = the person at the browser, "me" = Edmund. */
  from: "them" | "me";
  text: string;
  at: string;
  /** Which panel they were on: home | kitchen | history | shopping | recap. */
  page?: string | null;
  /** The specific thing on that page, e.g. a recipe id or an item slug. */
  subject?: string | null;
  /** Client-side id, so an answer can be matched to its question. */
  id?: string | null;
};

/** A principal as a filename. The whole string is kept, so distinct principals never collide. */
function safe(principal: string): string {
  return principal.replace(/[^A-Za-z0-9+.-]/g, "_");
}

function threadPath(account: string, principal: string): string {
  return join(accountDir(), account, "chat", `${safe(principal)}.jsonl`);
}

export function readThread(account: string, principal: string, limit = 60): ChatTurn[] {
  const p = threadPath(account, principal);
  if (!existsSync(p)) return [];
  const out: ChatTurn[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChatTurn);
    } catch {
      // A torn line costs that line, as in the ledger reader.
    }
  }
  return out.slice(-limit);
}

export function appendTurn(
  account: string,
  principal: string,
  turn: Omit<ChatTurn, "at"> & { at?: string },
): ChatTurn {
  const dir = join(accountDir(), account, "chat");
  mkdirSync(dir, { recursive: true });
  const full: ChatTurn = { ...turn, at: turn.at ?? nowIso() };
  appendFileSync(threadPath(account, principal), `${JSON.stringify(full)}\n`);
  return full;
}

/**
 * Publish each member's thread next to the page, which polls it.
 *
 * The page is static behind a share token, so a file is the only way a reply
 * reaches it. `chat/` must not start with an underscore: the share server
 * refuses to serve those, which is what keeps the inbound callback log
 * write-only. Readers need the share key, the same boundary as the rest of the
 * site.
 */
export function publishThreads(account: string, principals: string[], outDir: string): number {
  const dir = join(outDir, "chat");
  mkdirSync(dir, { recursive: true });
  const mine = new Set(principals.map((p) => `${safe(p)}.json`));
  let n = 0;
  for (const p of principals) {
    const turns = readThread(account, p, 100);
    writeFileSync(join(dir, `${safe(p)}.json`), JSON.stringify({ turns }));
    n += 1;
  }
  // Remove any thread that is not a current member's. The directory belongs to
  // one household, and a stale file (another household's render, a member who
  // left) would be readable by anyone holding this site's key.
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json") && !mine.has(f)) rmSync(join(dir, f), { force: true });
  }
  return n;
}

/** Threads with something in them, for a tool that needs to find unanswered ones. */
export function openQuestions(
  account: string,
  principals: string[],
): Array<{ principal: string; turn: ChatTurn }> {
  const out: Array<{ principal: string; turn: ChatTurn }> = [];
  for (const p of principals) {
    const t = readThread(account, p, 20);
    const last = t[t.length - 1];
    // Unanswered means the last word was theirs; re-answering a finished
    // exchange would make the chat talk to itself.
    if (last && last.from === "them") out.push({ principal: p, turn: last });
  }
  return out;
}
