import { existsSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { Hono } from "hono";
import { renderAnnotatePage, renderExpiredPage } from "../../../src/annotate/page.ts";
import { RateLimiter } from "../../../src/annotate/rate-limit.ts";
import type { AnnotationStore } from "../../../src/annotate/store.ts";
import { killTunnel } from "../../../src/annotate/tunnel.ts";
import type { CronStore } from "../../../src/cron/store.ts";
import { generatedPath } from "../../../src/persona/media-paths.ts";
import { ensureSandbox } from "../../../src/persona/sandbox.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";

type Deps = {
  store: AnnotationStore;
  crons: CronStore;
  contacts: ContactBook;
};

const MAX_PNG_BYTES = 25 * 1024 * 1024; // 25MB — guard against abuse

/**
 * One limiter, shared across the GET and POST handlers. A phone typically
 * makes ~3-5 requests to render the page (HTML + image + any retries) and
 * then 1 submit, so 20/min gives headroom while still catching attackers
 * spraying guesses. The exact number is tunable — this is a safety net,
 * not a primary auth mechanism (that's the 192-bit key).
 */
const limiter = new RateLimiter({ max: 20, windowMs: 60_000 });

/** One flat, opaque page for every auth failure — never hint at which check tripped. */
const GONE_BODY = "This link is invalid or has expired. Ask Edmund for a fresh one.";

/**
 * Unauthenticated routes that power the mobile image-annotation feature.
 *
 * Access is gated by the /a/<id>/<key> URL, not by the dashboard PIN — the
 * whole point is that the model can send the link to a user who doesn't
 * have the PIN.
 *
 * Defense layers:
 *   1. 192-bit random key in the URL. Not guessable.
 *   2. Only sha256(key) is stored; DB read does not reveal working URLs.
 *   3. Verification is constant-time (see AnnotationStore.verify).
 *   4. Every auth failure returns the same generic 410 body — an attacker
 *      can't distinguish "bad id", "bad key", "used", or "expired".
 *   5. Per-IP rate limiter clamps enumeration attempts.
 *   6. Links are single-use.
 *
 * Routes:
 *   GET  /a/:id/:key          — HTML annotation page
 *   GET  /a/:id/:key/image    — raw bytes of the source image
 *   POST /api/a/:id/:key      — submit comment + annotated PNG
 */
export function annotatePageRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/:id/:key", (c) => {
    if (!limiter.allow(clientIp(c))) return c.html(renderExpiredPage(GONE_BODY), 429);
    const { id, key } = c.req.param();
    const record = deps.store.verify(id, key);
    if (!record) return c.html(renderExpiredPage(GONE_BODY), 410);
    if (!existsSync(record.imagePath)) return c.html(renderExpiredPage(GONE_BODY), 410);

    const html = renderAnnotatePage({
      id: record.id,
      imageUrl: `/a/${id}/${key}/image`,
      instruction: record.instruction,
      submitUrl: `/api/a/${id}/${key}`,
    });
    return c.html(html);
  });

  app.get("/:id/:key/image", (c) => {
    if (!limiter.allow(clientIp(c))) return c.text(GONE_BODY, 429);
    const { id, key } = c.req.param();
    const record = deps.store.verify(id, key);
    if (!record) return c.text(GONE_BODY, 410);
    if (!existsSync(record.imagePath)) return c.text(GONE_BODY, 410);
    return new Response(Bun.file(record.imagePath), {
      headers: { "Content-Type": mimeFromPath(record.imagePath) },
    });
  });

  return app;
}

/**
 * POST handler. Mounted at /api/a/:id/:key in main.ts — but outside the
 * authMiddleware chain because the URL's key is the auth.
 */
export function annotateSubmitRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.post("/:id/:key", async (c) => {
    if (!limiter.allow(clientIp(c))) return c.json({ error: GONE_BODY }, 429);
    const { id, key } = c.req.param();
    const record = deps.store.verify(id, key);
    if (!record) return c.json({ error: GONE_BODY }, 410);

    const body = (await c.req.json().catch(() => null)) as {
      comment?: string;
      rects?: Array<{ x: number; y: number; w: number; h: number }>;
      annotatedPng?: string;
    } | null;
    if (!body) return c.json({ error: "invalid json" }, 400);

    const comment = (body.comment ?? "").trim();
    const rects = Array.isArray(body.rects) ? body.rects : [];
    if (!comment && rects.length === 0) {
      return c.json({ error: "comment or region required" }, 400);
    }

    // Decode the PNG dataURL and save to the session's sandbox so Claude can
    // Read it on the next turn. We reuse generatedPath() + the `images`
    // bucket since this is a user-authored image (the annotated version).
    let savedPath: string | null = null;
    if (body.annotatedPng?.startsWith("data:image/png;base64,")) {
      const b64 = body.annotatedPng.slice("data:image/png;base64,".length);
      // Base64 is 4/3 the size of what it encodes. Check the string before
      // allocating the decoded buffer so an oversized upload costs a length
      // comparison, not a 25 MB allocation.
      if (b64.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4) {
        return c.json({ error: "annotated image too large" }, 413);
      }
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length > MAX_PNG_BYTES) {
        return c.json({ error: "annotated image too large" }, 413);
      }
      const sandboxPath = ensureSandbox(record.sessionKey, null);
      savedPath = generatedPath(sandboxPath, "images", "png", "annotation");
      writeFileSync(savedPath, bytes);
    }

    // Compose the synthetic event. This flows through fireJob exactly like
    // a cron wake-up; Claude sees it as a "[Scheduled event ...]" envelope
    // followed by this body text. senderLabel will be "scheduler" so the
    // prompt tells the model who the user is and why this turn exists.
    const senderLabel =
      deps.contacts.displayName(record.senderHandle ?? "") ?? record.senderHandle ?? "the user";
    const event = buildEvent({
      senderLabel,
      imagePath: savedPath ?? record.imagePath,
      comment,
      rects,
    });
    // Pass the annotated PNG as an inline image so the model sees the exact
    // marked-up artifact on the wake-up turn without a Read call. Falls back
    // to the original image when the user submitted text-only.
    const imageForTurn = savedPath ?? record.imagePath;
    deps.crons.create({
      sessionKey: record.sessionKey,
      systemEvent: event,
      schedule: { kind: "once", atMs: Date.now() + 500 },
      attachImages: isInlineImagePath(imageForTurn) ? [imageForTurn] : undefined,
    });
    deps.store.markUsed(record.id);
    // End the Cloudflare tunnel now that the link has served its purpose.
    // The wrapper's TTL would kill it eventually, but dropping it immediately
    // means the public URL stops answering the moment the user hits send.
    if (record.tunnelPid) killTunnel(record.tunnelPid);
    console.log(
      `[annotate] submit id=${id} session=${record.sessionKey} rects=${rects.length} chars=${comment.length} tunnel_pid=${record.tunnelPid ?? "(none)"}`,
    );

    return c.json({ ok: true });
  });

  return app;
}

function buildEvent(params: {
  senderLabel: string;
  imagePath: string;
  comment: string;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
}): string {
  const lines: string[] = [];
  lines.push(
    `${params.senderLabel} just submitted annotations on the image you shared via the markup link.`,
  );
  lines.push("");
  lines.push(`Annotated image (PNG with numbered red boxes overlaid): ${params.imagePath}`);
  lines.push("");
  if (params.rects.length > 0) {
    lines.push(`Regions (${params.rects.length}) in normalized 0..1 coords:`);
    for (let i = 0; i < params.rects.length; i++) {
      const r = params.rects[i]!;
      lines.push(
        `  ${i + 1}. x=${r.x.toFixed(3)} y=${r.y.toFixed(3)} w=${r.w.toFixed(3)} h=${r.h.toFixed(3)}`,
      );
    }
    lines.push("");
  }
  if (params.comment) {
    lines.push("User's comment:");
    lines.push(params.comment);
  } else {
    lines.push("(No comment — interpret the regions as the change request.)");
  }
  lines.push("");
  lines.push(
    "Respond to the user in iMessage as you normally would: acknowledge what they want, then either act on it (edit the image, regenerate a logo, etc.) or ask the one clarifying question you most need.",
  );
  return lines.join("\n");
}

/**
 * Best-effort client IP for the rate limiter. Honors X-Forwarded-For when
 * set by a trusted tunnel (cloudflared, ngrok) — falls back to the direct
 * socket address Bun exposes via c.env.
 */
function clientIp(c: {
  req: { header: (name: string) => string | undefined };
  env: unknown;
}): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  const envAny = c.env as {
    ip?: string;
    server?: { requestIP?: (r: unknown) => { address?: string } | null };
  } | null;
  if (envAny?.ip) return envAny.ip;
  return "unknown";
}

function isInlineImagePath(p: string): boolean {
  return /\.(jpe?g|png|gif|webp|heic|heif|tiff|bmp)$/i.test(p);
}

function mimeFromPath(p: string): string {
  const ext = extname(p).toLowerCase().slice(1);
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    svg: "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}
