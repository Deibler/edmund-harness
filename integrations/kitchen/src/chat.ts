/**
 * The conversation that happens ON the site.
 *
 * Asking "can I swap the cream for milk" while looking at a recipe should not
 * require switching to Messages, retyping which recipe, and waiting. So the
 * page carries a thread, and the thread is per PERSON rather than per
 * household: two people sharing a kitchen do not share a train of thought, and
 * a reply meant for Alex appearing under Sam's profile would be worse than
 * having no chat at all.
 *
 * Every message records the page it was sent from. That context is the whole
 * reason an on-page chat beats a text message — "how do I cut this" means
 * something specific when the answer knows you were looking at the onion.
 *
 * Storage is one JSONL per person, append-only, because a conversation IS a
 * log: it only ever grows, and order is the meaning.
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

function safe(principal: string): string {
  // A principal is "imessage:dm:+1717...". Anything that is not obviously safe
  // in a filename becomes an underscore; collisions across principals are not
  // possible because the whole string is encoded, not truncated.
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
      // A torn line costs that line. Same call as the ledger reader.
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
 * Publish each person's thread next to the page so the browser can read it.
 *
 * The page is static behind a share token and cannot call anything, so a reply
 * reaches it exactly one way: as a file it polls. `chat/` deliberately does NOT
 * start with an underscore, because the share server refuses to GET those — the
 * underscore prefix is what keeps the inbound callback log write-only, and this
 * is the outbound half.
 *
 * Each thread is only readable by someone who already holds the share key, which
 * is the same trust boundary as the rest of the site: everyone with the link can
 * see the household's food, and these are members of that household.
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
  // Prune anything that is not a current member's thread.
  //
  // Publishing without pruning is a data leak waiting to happen: rendering a
  // DIFFERENT household into this directory once left that household's thread
  // sitting here, readable by anyone holding this site's share key. A member
  // who leaves would leave their conversation behind the same way. The output
  // directory belongs to exactly one account, so anything else in here is
  // wrong by definition.
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
    // Unanswered means the last word was theirs. Anything else is a finished
    // exchange, and re-answering a finished exchange is how a chat starts
    // talking to itself.
    if (last && last.from === "them") out.push({ principal: p, turn: last });
  }
  return out;
}
