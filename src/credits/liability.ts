import { type FetchLike, accountCredits } from "./openrouter-keys.ts";
import { refreshWalletStatus } from "./provision.ts";
import type { CreditStore } from "./store.ts";

/**
 * The guard that checks outside our own books.
 *
 * Payments land in Stripe; generations draw on the operator's OpenRouter
 * account. Every wallet's remaining balance is therefore credit the
 * operator is holding on someone's behalf, and the account must cover the
 * sum — otherwise the next 402 lands on a person who has paid. Both numbers
 * come from OpenRouter, live.
 */

export type Liability = {
  /** Account credit left, or null when it could not be read. */
  accountRemainingUsd: number | null;
  /** Σ remaining across wallets in `wallet` mode that hold a key. */
  outstandingUsd: number;
  wallets: number;
  /** How many of those balances were actually read this pass. */
  walletsRead: number;
  /** True when the account cannot cover what people have paid for. */
  short: boolean;
};

export async function creditsLiability(p: {
  store: CreditStore;
  houseKey: string;
  fetch?: FetchLike;
}): Promise<Liability> {
  let accountRemainingUsd: number | null = null;
  if (p.houseKey) {
    try {
      accountRemainingUsd = (await accountCredits({ apiKey: p.houseKey, fetch: p.fetch }))
        .remainingUsd;
    } catch {
      accountRemainingUsd = null;
    }
  }
  const wallets = p.store.list().filter((w) => w.billingMode === "wallet" && w.apiKey);
  let outstanding = 0;
  let read = 0;
  for (const w of wallets) {
    const status = await refreshWalletStatus({ store: p.store, wallet: w, fetch: p.fetch });
    if (status && status.remainingUsd !== null) {
      outstanding += Math.max(0, status.remainingUsd);
      read++;
    } else if (w.lastSeenRemainingUsd !== null) {
      // Unreadable right now — count the last snapshot rather than zero.
      outstanding += Math.max(0, w.lastSeenRemainingUsd);
    }
  }
  return {
    accountRemainingUsd,
    outstandingUsd: Math.round(outstanding * 100) / 100,
    wallets: wallets.length,
    walletsRead: read,
    short: accountRemainingUsd !== null && accountRemainingUsd < outstanding,
  };
}
