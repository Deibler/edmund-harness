import { statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { listMedia, listMediaForSession, resolveMediaPath } from "../services/mediaIndex.ts";

type Deps = { state: StateStore; contacts: ContactBook; chatDb: ChatDb };

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".caf": "audio/x-caf",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
};

function mimeFor(path: string): string {
  const i = path.lastIndexOf(".");
  if (i < 0) return "application/octet-stream";
  return MIME[path.slice(i).toLowerCase()] ?? "application/octet-stream";
}

export function mediaRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const sessionKey = c.req.query("sessionKey");
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    if (sessionKey) {
      return c.json({ items: listMediaForSession(sessionKey, labelDeps) });
    }
    const keys = deps.state.listSessions().map((s) => s.sessionKey);
    return c.json({ items: listMedia(keys, labelDeps) });
  });

  app.get("/file", (c) => {
    const raw = c.req.query("path");
    if (!raw) return c.json({ error: "path required" }, 400);
    const abs = resolveMediaPath(raw);
    if (!abs) return c.json({ error: "forbidden" }, 403);
    let stat: Stats;
    try {
      stat = statSync(abs);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
    const file = Bun.file(abs);
    return new Response(file, {
      headers: {
        "Content-Type": mimeFor(abs),
        "Content-Length": String(stat.size),
        "Content-Disposition": `inline; filename="${basename(abs)}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  });

  return app;
}
