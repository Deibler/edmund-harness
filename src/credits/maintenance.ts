import type { OperatorAlert } from "../alerts/operator-alert.ts";
import type { Config } from "../config/config.ts";
import { log } from "../util/log.ts";
import { creditsLiability } from "./liability.ts";
import { CreditStore } from "./store.ts";

/**
 * The daemon's side of generation credits: once a day, read the OpenRouter
 * account and every wallet and alert the operator when the account cannot
 * cover what people have paid for. Nothing else runs on a timer — balances
 * and payments are read live when a page opens or a generation starts
 * (sync.ts), so there is no queue to sweep.
 *
 * Inert unless [credits].enabled.
 */
export function startCreditsMaintenance(p: {
  config: Config;
  alert: OperatorAlert;
  liabilityMs?: number;
}): { stop: () => void; liability: () => Promise<void> } {
  if (!p.config.credits.enabled) return { stop() {}, liability: async () => {} };

  const store = new CreditStore(p.config.paths.data_dir);

  const liability = async () => {
    try {
      const l = await creditsLiability({ store, houseKey: p.config.keys.openrouter });
      log.info("credits", "liability", {
        account: l.accountRemainingUsd,
        outstanding: l.outstandingUsd,
        wallets: l.wallets,
        read: l.walletsRead,
      });
      if (l.short) {
        void p.alert.notify({
          category: "credits account short",
          error: `OpenRouter account has $${l.accountRemainingUsd?.toFixed(2)} but people's wallets hold $${l.outstandingUsd.toFixed(2)} — add account credit before someone who paid gets a 402`,
        });
      }
    } catch (err) {
      log.error("credits", "liability check failed", { err: String(err) });
    }
  };

  const timer = setInterval(() => void liability(), p.liabilityMs ?? 24 * 3_600_000);
  timer.unref?.();
  const kick = setTimeout(() => void liability(), 5 * 60_000);
  kick.unref?.();

  return {
    liability,
    stop() {
      clearInterval(timer);
      clearTimeout(kick);
      try {
        store.close();
      } catch {}
    },
  };
}
