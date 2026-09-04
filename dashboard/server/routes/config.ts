import { Hono } from "hono";
import { invalidateConfig } from "../config.ts";
import { readConfigMasked, writeConfig } from "../services/configIO.ts";

export function configRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    try {
      return c.json({ config: readConfigMasked() });
    } catch (err) {
      return c.json({ error: "failed to load config", detail: String(err) }, 500);
    }
  });

  app.put("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      config?: Record<string, unknown>;
    } | null;
    if (!body?.config || typeof body.config !== "object") {
      return c.json({ error: "config required" }, 400);
    }
    try {
      const { backupPath } = await writeConfig(body.config);
      invalidateConfig();
      return c.json({ ok: true, backup: backupPath });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: "invalid config", detail }, 400);
    }
  });

  return app;
}
