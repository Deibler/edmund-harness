/**
 * Helpers shared by every kitchen tool module: the result shape, household
 * resolution, the common `account` argument, site-tap lookup and the
 * post-write re-render.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { ChatDb } from "../../../src/imessage/db.ts";
import { decodeMessageText } from "../../../src/imessage/decode.ts";
import { getGroupParticipants } from "../../../src/imessage/participants.ts";
import type { ToolContext } from "../../../src/mcp/context.ts";
import { dmKeyFor, isDmSession } from "../../../src/sessions/key.ts";
import { NoAccountError, getAccount, resolveAccount } from "../src/accounts.ts";
import { type Caller, MAX_GROUP, accountOf, offerBrief } from "../src/onboard.ts";
import { SAME_TURN_MS, consider } from "../src/prospects.ts";
import { pending, requestKey } from "../src/requests.ts";
import { writeSite } from "../src/site.ts";

/** A tool result carrying one block of text. */
export function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/** Any thrown value as an error result. */
export function failure(e: unknown) {
  return text(e instanceof Error ? e.message : String(e), true);
}

/**
 * Run a handler against the household the call resolves to. Every failure
 * comes back as an error result rather than a throw, except a chat that
 * belongs to no household, which gets `noKitchen`.
 */
export async function withAccount<T>(
  ctx: ToolContext,
  explicit: string | undefined,
  fn: (account: string) => Promise<T> | T,
) {
  try {
    return await fn(resolveAccount(explicit, ctx.sessionKey));
  } catch (e) {
    if (e instanceof NoAccountError && !explicit && ctx.sessionKey && !accountOf(ctx.sessionKey)) {
      return noKitchen(ctx);
    }
    return failure(e);
  }
}

const GROUP = "imessage:group:";

/**
 * The answer for a chat with no household. It is not an error: from
 * 2026-08-17 to 2026-10-20 this case came back as one 43 times, across about
 * 30 food questions, and the offer it carried was made twice. It says to
 * answer the question, then whether to offer a kitchen.
 */
export function noKitchen(ctx: ToolContext) {
  const who = ctx.sessionKey;
  if (!who || !(isDmSession(who) || who.startsWith(GROUP))) {
    return text("No kitchen is set up for this chat. Answer from what you know.");
  }
  const caller = callerOf(ctx);
  if (caller.group && caller.group.length > MAX_GROUP) {
    return text(offerBrief(caller, { kind: "offer", again: false }));
  }
  const { prospect, decision } = consider(who, { delivered: (at) => offerWentOut(ctx, at) });
  return text(offerBrief(caller, decision, prospect.asks));
}

/** For a group chat, who else is in it and which of them already has a kitchen. */
function callerOf(ctx: ToolContext): Caller {
  if (!ctx.sessionKey.startsWith(GROUP)) return {};
  const guid = ctx.chatGuids?.[0];
  if (!ctx.chatDb || !guid) return {};
  const handles = getGroupParticipants(ctx.chatDb, guid);
  const named = handles.map((h) => ({
    handle: h,
    name: ctx.contacts?.displayName(h)?.trim().split(/\s+/)[0] || h,
  }));
  return {
    group: named.map((n) => n.name),
    housed: named.flatMap((n) => {
      const account = accountOf(dmKeyFor(n.handle));
      return account ? [{ name: n.name, account }] : [];
    }),
  };
}

const OWN_SINCE_SQL = (n: number) => `
  SELECT m.text AS text, m.attributedBody AS body
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid IN (${Array(n).fill("?").join(",")}) AND m.is_from_me = 1 AND m.date BETWEEN ? AND ?
`;

/**
 * Words an offer cannot avoid and a cooking answer rarely uses. "Fridge" is
 * not one: "keep it in the fridge" would count a skipped offer as made.
 */
const OFFER_WORDS = /\bkitchen\b|\breceipts?\b/i;

/**
 * Whether a reply carrying the offer reached this chat in the twenty minutes
 * after it was due. Checked in chat.db, the record of what was actually sent;
 * null when there is no chat database to ask.
 */
function offerWentOut(ctx: ToolContext, at: string): boolean | null {
  if (!ctx.chatDb || !ctx.chatGuids?.length) return null;
  const ns = (ms: number) => (ms - ChatDb.APPLE_EPOCH_MS) * ChatDb.NS_PER_MS;
  const from = Date.parse(at);
  try {
    return ctx.chatDb
      .query<{ text: string | null; body: Uint8Array | null }>(OWN_SINCE_SQL(ctx.chatGuids.length))
      .all(...ctx.chatGuids, ns(from), ns(from + SAME_TURN_MS * 2))
      .some((r) => OFFER_WORDS.test(decodeMessageText(r.text, r.body)));
  } catch {
    return null;
  }
}

export const Acct = z
  .string()
  .optional()
  .describe("Household id. Omit in normal use — it resolves from the chat session.");

/** Whether a site tap of this kind with this key is still waiting to be served. */
export function isWaiting(id: string, kind: string, key: string): boolean {
  const dir = getAccount(id)?.site?.artifact;
  return !!dir && pending(id, dir).some((r) => r.kind === kind && requestKey(r) === key);
}

/**
 * Re-render the household's site after a write the page shows.
 *
 * The watch pass only re-renders after taps it settled itself, so a write made
 * through a tool would otherwise stay invisible until then. A failed render is
 * reported in the result, never thrown over a write that already happened.
 */
export function rerender(id: string): string | null {
  const acct = getAccount(id);
  const dir = acct?.site?.artifact;
  if (!acct || !dir || !existsSync(dir)) return null;
  try {
    writeSite(id, acct, dir);
    return null;
  } catch (e) {
    return `Render failed: ${(e as Error).message}`;
  }
}
