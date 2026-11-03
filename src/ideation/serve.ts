import { existsSync } from "node:fs";
import { join } from "node:path";
import { IDEATION_ID, type IdeationStore, ideationsDir } from "./store.ts";

/**
 * Serve a page Edmund built for someone: GET /i/<id>/ (the page) and
 * /i/<id>/thumb.jpg (its picture, for the portal and the link preview).
 *
 * The page is model-written JavaScript, so it runs in a sandbox the header
 * sets and no page can loosen: an opaque origin (no cookies or storage, and
 * nothing of the kitchen host's own), no network after it loads, and no way
 * to be framed or to post a form anywhere. Only a page the publish step
 * passed is served; everything else is a plain 404. The file is read from
 * disk on each request, so nothing runs until someone opens the link.
 */

/** The one policy every page runs under, here and in the publish check. */
export const IDEATION_CSP = [
  // allow-forms: without it a sandboxed page never fires `submit`, so a form's
  // handler (Enter in a field) would do nothing. form-action 'none' below
  // still stops any form from actually being sent anywhere.
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data: blob: https:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function ideationHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": IDEATION_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "private, max-age=60",
  };
}

/**
 * Link-preview fetchers open the page too: iMessage fetches it to draw the
 * bubble, under a user agent naming Facebook's and Twitter's crawlers. Those
 * are not a person opening it.
 */
const NOT_A_PERSON = /facebookexternalhit|facebot|twitterbot|bot\b|crawler|spider|preview/i;

export function isPersonOpening(req: Request): boolean {
  if (req.method !== "GET") return false;
  return !NOT_A_PERSON.test(req.headers.get("user-agent") ?? "");
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
}

/** A Response for /i/ paths, or null for anything else so a router can fall through. */
export function serveIdeation(
  req: Request,
  dataDir: string,
  store: IdeationStore,
  nowMs = Date.now(),
): Response | null {
  const url = new URL(req.url);
  if (url.pathname !== "/i" && !url.pathname.startsWith("/i/")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();
  const m = url.pathname.match(/^\/i\/([^/]+)(\/(thumb\.jpg)?)?$/);
  if (!m) return notFound();
  const [, id, slash, file] = m as unknown as [
    string,
    string,
    string | undefined,
    string | undefined,
  ];
  if (!IDEATION_ID.test(id)) return notFound();
  const row = store.get(id);
  if (!row || row.status !== "ready") return notFound();
  // A path, not an absolute URL: behind the tunnel the request arrives as
  // plain http, and an absolute Location would send the phone to http://.
  if (!slash) return new Response(null, { status: 301, headers: { Location: `/i/${id}/` } });

  const dir = join(ideationsDir(dataDir), id);
  const name = file ?? "index.html";
  const path = join(dir, name);
  if (!existsSync(path)) return notFound();
  const type = name === "thumb.jpg" ? "image/jpeg" : "text/html; charset=utf-8";
  if (!file && isPersonOpening(req)) store.recordOpen(id, nowMs);
  return new Response(req.method === "HEAD" ? null : Bun.file(path), {
    headers: ideationHeaders(type),
  });
}
