/**
 * Trading integration — public surface.
 *
 * Re-exports the pieces core needs (the router gate and session-key helper)
 * and provides `startTradingRuntime`, the daemon-side price-trigger watcher
 * declared in `manifest.yaml`.
 *
 * Everything else — the risk engine, execution path, broker clients, and
 * stores — stays private under `src/`. Core has no reason to reach them, and
 * keeping them unexported means the blast radius of a refactor is this
 * package.
 */

import type { Config } from "../../src/config/config.ts";
import type { IntegrationRuntime, IntegrationRuntimeContext } from "../../src/integrations/host.ts";
import type { SessionKey } from "../../src/sessions/key.ts";
import { log } from "../../src/util/log.ts";
import { tradingConfig } from "./config.ts";
import { getBroker } from "./src/broker.ts";
import { TriggerStore } from "./src/trigger-store.ts";
import { TriggerWatcher } from "./src/trigger-watcher.ts";

// Router surface: `main.ts` asks this whether an inbound belongs to the
// trading sub-persona. Re-exported (not re-implemented) so the routing rule
// has exactly one definition.
export { tradingGate } from "./src/route.ts";
export type { Broker } from "./src/broker.ts";

/**
 * Start the price-trigger watcher. Polls armed triggers and, on a threshold
 * cross, injects a one-shot system event into the owning trading session via
 * the host's `fireSystemEvent` — the same cron-backed wake path agent
 * completions use, so no second fire mechanism exists.
 */
export async function startTradingRuntime(
  ctx: IntegrationRuntimeContext,
): Promise<IntegrationRuntime | null> {
  const config = ctx.config as Config;
  if (!tradingConfig(config)?.enabled) return null;

  const store = new TriggerStore(config.paths.data_dir);
  const { broker, backend } = await getBroker(config);

  const watcher = new TriggerWatcher({
    store,
    intervalMs: tradingConfig(config).poll_interval_seconds * 1000,
    broker,
    fire: (sessionKey, systemEvent) => ctx.fireSystemEvent(sessionKey as SessionKey, systemEvent),
    onError: (err) => log.error("trading", "trigger watcher error", { err: String(err) }),
  });
  watcher.start();
  log.info("trading", "price-trigger watcher started", { broker_backend: backend });

  return {
    stop: () => {
      watcher.stop();
      store.close();
    },
  };
}
