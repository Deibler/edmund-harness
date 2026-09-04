import { Hono } from "hono";
import type { ChatDb } from "../../../src/imessage/db.ts";
import { getRecentMessages } from "../../../src/imessage/history.ts";
import { sendMessage } from "../../../src/imessage/send.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { chatIdFromKey, isGroupSession } from "../../../src/sessions/key.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import type { ChatLine } from "../types.ts";

type Deps = { state: StateStore; chatDb: ChatDb; contacts: ContactBook };

export function messagesRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/:key/history", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const rec = deps.state.getSession(key);
    if (!rec) return c.json({ error: "session not found" }, 404);
    const limit = Math.min(500, Number.parseInt(c.req.query("limit") ?? "100", 10));
    const beforeRowId = Number.parseInt(c.req.query("beforeRowId") ?? "9999999999", 10);
    const lines = getRecentMessages(deps.chatDb, rec.chatGuid, beforeRowId, limit);
    const chatLines: ChatLine[] = lines.map((l) => ({
      rowId: l.rowId,
      timestampMs: l.timestampMs,
      fromHandle: l.fromHandle,
      fromLabel: l.fromMe ? "You" : (deps.contacts.displayName(l.fromHandle) ?? l.fromHandle),
      fromMe: l.fromMe,
      text: l.text,
    }));
    return c.json({ lines: chatLines });
  });

  app.post("/:key/send", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    if (!body?.text || !body.text.trim()) return c.json({ error: "text required" }, 400);
    const rec = deps.state.getSession(key);
    if (!rec) return c.json({ error: "session not found" }, 404);
    const isGroup = isGroupSession(key);
    const to = isGroup ? rec.chatGuid : chatIdFromKey(key);
    const res = await sendMessage({ to, isGroup, text: body.text });
    console.log(`[dashboard] manual-send key=${key} chars=${body.text.length} ok=${res.ok}`);
    if (!res.ok) return c.json({ error: res.error ?? "send failed" }, 500);
    return c.json({ ok: true });
  });

  return app;
}
