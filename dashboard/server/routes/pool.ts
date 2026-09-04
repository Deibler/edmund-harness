import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { ResourceStatus } from "../../../src/boot/resource-governor.ts";
import type { Config } from "../../../src/config/config.ts";
import type { PoolStatsDto } from "../types.ts";

/**
 * Claude worker-pool live state. The daemon writes a snapshot to
 * `${data_dir}/pool-stats.json` every 30s (see main.ts); we just read it.
 * Flushing the pool sends a kick file the daemon's main loop consumes.
 */
export function poolRoutes(deps: { config: Config }): Hono {
  const app = new Hono();
  const statsPath = resolve(deps.config.paths.data_dir, "pool-stats.json");
  const resourcePath = resolve(deps.config.paths.data_dir, "resource-status.json");
  const flushPath = resolve(deps.config.paths.data_dir, "pool-flush.kick");

  const resources = (): ResourceStatus | null => {
    try {
      return JSON.parse(readFileSync(resourcePath, "utf8")) as ResourceStatus;
    } catch {
      return null;
    }
  };

  app.get("/", (c) => {
    if (!existsSync(statsPath)) {
      return c.json({
        stats: null,
        config: deps.config.claude.pool,
        resources: resources(),
      });
    }
    try {
      const raw = readFileSync(statsPath, "utf8");
      const parsed = JSON.parse(raw) as PoolStatsDto & {
        deaths: Array<{ reason: string; n: number }>;
        workers: Array<{
          sessionKey: string;
          rebindKey: string;
          lastUsedMs: number;
          pid: number | null;
          isDead: boolean;
        }>;
      };
      return c.json({
        stats: parsed,
        config: deps.config.claude.pool,
        resources: resources(),
      });
    } catch {
      return c.json({ stats: null, config: deps.config.claude.pool, resources: resources() });
    }
  });

  app.post("/flush", (c) => {
    writeFileSync(flushPath, String(Date.now()));
    return c.json({ kicked: true });
  });

  return app;
}
