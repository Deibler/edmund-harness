import { type FetchLike, type KeyStatus, createKey, keySelfStatus } from "./openrouter-keys.ts";
import type { CreditStore, Wallet } from "./store.ts";

/**
 * Minting — the one path that turns a wallet row into a real OpenRouter key.
 *
 * Shared by the generation path (first charged generation), the portal
 * (Credits tab viewed before any generation), the webhook (payment lands
 * for someone with no key yet), and the CLI/dashboard grant. One function
 * so the key name, starter limit and persistence are identical everywhere.
 */

export class CreditsUnavailable extends Error {
  constructor(detail: string) {
    super(`credits system unavailable: ${detail}`);
    this.name = "CreditsUnavailable";
  }
}

export const KEY_NAME_PREFIX = "edmund:";

export async function ensureWalletKey(p: {
  store: CreditStore;
  sessionKey: string;
  provisioningKey: string;
  starterUsd: number;
  fetch?: FetchLike;
}): Promise<Wallet> {
  const existing = p.store.ensure(p.sessionKey);
  if (existing.apiKey && existing.keyHash) return existing;
  if (!p.provisioningKey) {
    throw new CreditsUnavailable("keys.openrouter_provisioning is not set");
  }
  let minted: { apiKey: string; status: KeyStatus };
  try {
    minted = await createKey({
      provisioningKey: p.provisioningKey,
      name: `${KEY_NAME_PREFIX}${p.sessionKey}`,
      limitUsd: p.starterUsd,
      fetch: p.fetch,
    });
  } catch (err) {
    throw new CreditsUnavailable(`could not mint a key: ${(err as Error).message}`);
  }
  if (!minted.status.hash) {
    throw new CreditsUnavailable("OpenRouter returned a key without a hash");
  }
  return p.store.attachKey(p.sessionKey, {
    hash: minted.status.hash,
    apiKey: minted.apiKey,
    limitUsd: minted.status.limitUsd ?? p.starterUsd,
    starterUsd: p.starterUsd,
  });
}

/** Live balance for a wallet, read with the wallet's OWN key, and mirrored
 *  into the display columns. Null when the read fails — callers must treat
 *  null as "unknown", never as zero. */
export async function refreshWalletStatus(p: {
  store: CreditStore;
  wallet: Wallet;
  fetch?: FetchLike;
}): Promise<KeyStatus | null> {
  if (!p.wallet.apiKey) return null;
  try {
    const status = await keySelfStatus({ apiKey: p.wallet.apiKey, fetch: p.fetch });
    p.store.recordSeen(p.wallet.sessionKey, {
      usageUsd: status.usageUsd,
      remainingUsd: status.remainingUsd,
      limitUsd: status.limitUsd,
    });
    return status;
  } catch {
    return null;
  }
}
