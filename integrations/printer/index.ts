import { resolve } from "node:path";
import type { IntegrationRuntime, IntegrationRuntimeContext } from "../../src/integrations/host.ts";
import { log } from "../../src/util/log.ts";
import { isConfigured, printerConfig } from "./config.ts";
import { startRuntime } from "./src/runtime.ts";

/**
 * The printer's daemon runtime: one connection to the printer, the watches,
 * the approvals, the gated start/cancel/resume, and the live print page.
 * See src/runtime.ts.
 */
export function startPrinter(ctx: IntegrationRuntimeContext): IntegrationRuntime {
  const cfg = printerConfig(ctx.config);
  if (!isConfigured(cfg)) {
    log.info("printer", "not configured ([printer] host, access_code and serial); runtime idle");
    return { stop: () => {} };
  }
  const dataDir = resolve(process.env.EDMUND_DATA_DIR ?? ctx.config.paths.data_dir);
  const rt = startRuntime(ctx.config, cfg, dataDir, (session, text, opts) =>
    ctx.fireSystemEvent(session, text, opts),
  );
  return { stop: () => rt?.stop() };
}
