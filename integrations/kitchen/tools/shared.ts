/**
 * Helpers shared by every kitchen tool module: the result shape, household
 * resolution, the common `account` argument, site-tap lookup and the
 * post-write re-render.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import { getAccount, resolveAccount } from "../src/accounts.ts";
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
 * Run a handler against the household the call resolves to. Every failure,
 * including a session that belongs to no household, comes back as an error
 * result rather than a throw.
 */
export async function withAccount<T>(
  ctx: ToolContext,
  explicit: string | undefined,
  fn: (account: string) => Promise<T> | T,
) {
  try {
    return await fn(resolveAccount(explicit, ctx.sessionKey));
  } catch (e) {
    return failure(e);
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
