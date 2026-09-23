/**
 * Which shared notes a session may edit on screen.
 *
 * Every household has one list note, shared with its members. Computer use
 * must only ever write the list of the household the request came from, and
 * several lists sit side by side in the same Notes account, so core asks here
 * rather than guessing from titles. Membership is the registry's, the same
 * binding every kitchen tool resolves through.
 */

import type { Config } from "../../src/config/config.ts";
import { listAccounts } from "./src/accounts.ts";
import { noteTitle } from "./src/notelist.ts";
import { applyKitchenConfig } from "./src/settings.ts";

export function screenScope(
  sessionKey: string,
  config: Config,
): { own: string[]; others: string[] } {
  applyKitchenConfig(config);
  const own: string[] = [];
  const others: string[] = [];
  for (const account of listAccounts()) {
    (account.members.includes(sessionKey) ? own : others).push(noteTitle(account.id));
  }
  return { own, others };
}
