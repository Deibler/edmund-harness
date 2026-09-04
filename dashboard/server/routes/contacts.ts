import { Hono } from "hono";
import { readConfigRaw, writeConfig } from "../services/configIO.ts";
import type { ContactDto } from "../types.ts";

/**
 * CRUD over the [[contacts]] array in config.toml. The generic config form
 * can't render an editable array-of-objects, so contacts get their own
 * focused UI. Every write goes through writeConfig() so a dated backup
 * is created on every save.
 */
export function contactsRoutes(): Hono {
  const app = new Hono();

  function load(): ContactDto[] {
    const raw = readConfigRaw();
    const contacts = (raw.contacts ?? []) as ContactDto[];
    return contacts.map((c) => ({
      name: c.name,
      handles: c.handles ?? [],
      notes: (c as { notes?: string }).notes,
    }));
  }

  app.get("/", (c) => c.json({ contacts: load() }));

  app.put("/", async (c) => {
    const body = (await c.req.json()) as { contacts: ContactDto[] };
    if (!Array.isArray(body.contacts)) {
      return c.json({ error: "contacts array required" }, 400);
    }
    // Validate shape minimally; ConfigSchema.parse in writeConfig will do
    // the strict pass (handles non-empty).
    for (const e of body.contacts) {
      if (!Array.isArray(e.handles) || e.handles.length === 0) {
        return c.json({ error: `contact "${e.name ?? "?"}" must have ≥1 handle` }, 400);
      }
    }
    const current = readConfigRaw();
    const next = { ...current, contacts: body.contacts };
    try {
      const { backupPath } = await writeConfig(next);
      return c.json({ ok: true, backup: backupPath });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return app;
}
