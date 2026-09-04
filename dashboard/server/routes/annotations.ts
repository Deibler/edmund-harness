import { Hono } from "hono";
import type { AnnotationStore } from "../../../src/annotate/store.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { sessionLabel } from "../services/labels.ts";
import type { AnnotationDto } from "../types.ts";

/**
 * Dashboard view + revoke for annotation links. Distinct from /a/*
 * (the public phone-facing pages, gated by URL key, not by auth).
 */
export function annotationsRoutes(deps: {
  store: AnnotationStore;
  contacts: ContactBook;
  chatDb: ChatDb;
}): Hono {
  const app = new Hono();
  const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };

  app.get("/", (c) => {
    const sessionKey = c.req.query("session") || undefined;
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
    const rows = deps.store.listRecent({ sessionKey, limit });
    const now = Date.now();
    const annotations: AnnotationDto[] = rows.map((r) => ({
      id: r.id,
      sessionKey: r.sessionKey,
      sessionLabel: sessionLabel(r.sessionKey, labelDeps),
      senderHandle: r.senderHandle ?? "",
      imagePath: r.imagePath,
      instruction: r.instruction ?? "",
      createdAtMs: r.createdAtMs,
      expiresAtMs: r.expiresAtMs,
      usedAtMs: r.used ? r.expiresAtMs : null,
      submittedAtMs: null,
      submittedJson: null,
      tunnelPid: r.tunnelPid,
      status: r.used ? "used" : r.expiresAtMs < now ? "expired" : "pending",
    }));
    return c.json({ annotations });
  });

  app.post("/:id/revoke", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const ok = deps.store.revoke(id);
    return c.json({ revoked: ok });
  });

  return app;
}
