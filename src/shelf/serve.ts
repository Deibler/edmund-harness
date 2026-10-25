import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ShelfEntry, readShelfIndex } from "./shelf.ts";

/**
 * Serve /shelf/<token>/ (the shelf's page, newest first) and
 * /shelf/<token>/<name> (one file). Byte ranges are honoured, because iPhone
 * Safari will not play a video from a server that ignores them. Returns null
 * for anything that is not a shelf path, so a router can fall through.
 */
export function serveShelf(req: Request, rootDir: string): Response | null {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/shelf\/([a-f0-9]{32})\/?(.*)$/);
  if (!m) return url.pathname.startsWith("/shelf/") ? notFound() : null;
  const [, token, rawName] = m as unknown as [string, string, string];
  const dir = join(rootDir, token);
  if (!existsSync(dir)) return notFound();
  const name = decodeURIComponent(rawName);
  if (!name) return shelfPage(dir);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".") || name === "index.json") {
    return notFound();
  }
  const path = join(dir, name);
  if (!existsSync(path)) return notFound();
  const file = Bun.file(path);
  const size = file.size;
  const headers: Record<string, string> = {
    "Content-Type": file.type || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
    "X-Robots-Tag": "noindex",
  };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(req.method === "HEAD" ? null : file, {
    headers: { ...headers, "Content-Length": String(size) },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function shelfPage(dir: string): Response {
  let entries: ShelfEntry[] = readShelfIndex(dir);
  if (entries.length === 0) {
    entries = readdirSync(dir)
      .filter((f) => !f.startsWith(".") && f !== "index.json")
      .map((f) => {
        const st = statSync(join(dir, f));
        return { name: f, title: f, addedMs: st.mtimeMs, bytes: st.size };
      });
  }
  entries.sort((a, b) => b.addedMs - a.addedMs);
  const rows = entries
    .map((e) => {
      const day = new Date(e.addedMs).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const kb =
        e.bytes > 1_048_576
          ? `${(e.bytes / 1_048_576).toFixed(1)} MB`
          : `${Math.max(1, Math.round(e.bytes / 1024))} KB`;
      return `<li><a href="${encodeURIComponent(e.name)}">${escapeHtml(e.title)}</a><span>${day} · ${kb}</span></li>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Your shelf</title><style>
:root{--bg:#faf8f4;--ink:#1d1b18;--muted:#6b665e;--line:#e4dfd6}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--ink:#ece8e1;--muted:#9a948a;--line:#2c2a26}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:28px 16px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
ul{list-style:none;padding:0;margin:0}li{display:flex;flex-direction:column;padding:12px 0;border-top:1px solid var(--line)}
a{color:var(--ink);font-weight:600;text-decoration:none;word-break:break-word}span{color:var(--muted);font-size:14px}
</style></head><body><main><h1>Your shelf</h1><p>Everything Edmund has made for you, newest first. This page and its links stay put.</p><ul>
${rows || "<li><span>Nothing here yet.</span></li>"}
</ul></main></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
