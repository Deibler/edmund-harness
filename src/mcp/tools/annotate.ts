import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { AnnotationStore } from "../../annotate/store.ts";
import { startQuickTunnel } from "../../annotate/tunnel.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const DEFAULT_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 60;

const RequestInput = z.object({
  image_path: z
    .string()
    .describe(
      "Absolute path to the image the user should mark up. Works for any raster or vector image the dashboard can serve (PNG, JPEG, HEIC, WebP, SVG, etc.). Typically a file from this session's sandbox (images/, received-images/).",
    ),
  instruction: z
    .string()
    .optional()
    .describe(
      "Short hint shown above the image on the page, e.g. 'Circle the parts of the logo you want redesigned'. Omit for the generic default.",
    ),
  ttl_minutes: z
    .number()
    .positive()
    .max(MAX_TTL_MINUTES)
    .optional()
    .describe(
      `How long the link stays valid. Default ${DEFAULT_TTL_MINUTES} min, max ${MAX_TTL_MINUTES} min. If the user takes longer and the link expires, just call this tool again to generate a fresh one.`,
    ),
});

/**
 * Produces a one-shot, single-use URL that opens a mobile-friendly page
 * where the user can drag rectangles over the image and add a comment.
 * When they hit send, the dashboard writes a cron row that re-invokes
 * Claude for this exact session — the next turn lands as if the user had
 * iMessaged the annotated image plus their comment.
 *
 * Use this whenever you've produced (or received) a logo/image/mockup and
 * want targeted feedback instead of free-form "change the color I guess".
 *
 * The URL is served through a Cloudflare quick tunnel
 * (https://*.trycloudflare.com), so it works from anywhere — not just the
 * same Wi-Fi as the host Mac. The tunnel and the link both expire after
 * TTL minutes. If cloudflared fails to start, we fall back to a LAN URL.
 */
export function annotateTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "request_image_annotation",
      description:
        "Generate a shareable URL the user opens on their phone to highlight areas of an image and describe changes. When they hit send, your session is automatically re-invoked with the annotated image + their comment — so you can respond as though they'd iMessaged it. Ideal for iterating on logos, mockups, screenshots, or any visual you want pointed feedback on. Send the returned URL to the user via send_message. The link lasts ~10 minutes; if the user says it stopped working, just call this tool again for a fresh URL.",
      inputSchema: RequestInput,
      handler: async (args) => {
        try {
          assertPathSafe(args.image_path);
        } catch (err) {
          return {
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          };
        }
        if (!existsSync(args.image_path)) {
          return {
            content: [{ type: "text", text: `File not found: ${args.image_path}` }],
            isError: true,
          };
        }
        const ttlMinutes = args.ttl_minutes ?? DEFAULT_TTL_MINUTES;
        const ttlMs = ttlMinutes * 60_000;

        // HEIC (iMessage default) and a few other formats don't render
        // reliably in mobile/desktop browsers' <img> elements. If the
        // source isn't one of PNG/JPEG/GIF/WebP/SVG, transcode to JPEG
        // via `sips` into a per-session cache and point the record at the
        // converted copy. Failure falls back to the original path — the
        // dashboard will still try; the user may hit the "image
        // unavailable" page, but that's no worse than today.
        const browserPath = ensureBrowserFriendly(args.image_path, ctx.sandboxPath);

        const store = new AnnotationStore(ctx.dataDir);
        try {
          const senderHandle = pickSenderHandle(ctx);
          const record = store.create({
            sessionKey: ctx.sessionKey,
            senderHandle,
            imagePath: browserPath,
            instruction: args.instruction ?? null,
            ttlMs,
          });

          // Try for a public cloudflared URL first. Fall back to LAN if the
          // tunnel can't come up — the link still works for users on the
          // same Wi-Fi and the failure is explicit to the operator.
          const port = ctx.config.dashboard.port;
          const tunnelResult = await tryStartTunnel(port, Math.ceil(ttlMs / 1000));
          const baseUrl = tunnelResult.ok ? tunnelResult.url : resolveLanBaseUrl(ctx);
          if (tunnelResult.ok) {
            store.setTunnelPid(record.id, tunnelResult.managerPid);
          }

          const url = `${baseUrl}/a/${record.id}/${record.key}`;
          const expiresAt = new Date(record.expiresAtMs).toISOString();
          const lines: string[] = [];
          lines.push(`Annotation link: ${url}`);
          lines.push(`Expires: ${expiresAt} (${ttlMinutes} min, single-use)`);
          lines.push("");
          if (tunnelResult.ok) {
            lines.push(
              "This URL goes through a temporary Cloudflare tunnel — the user can open it from any network. The tunnel shuts down when they submit or when the TTL elapses.",
            );
          } else {
            lines.push(
              `Cloudflare tunnel failed to start (${tunnelResult.reason}). Link falls back to a LAN URL (${baseUrl}) — only works when the user's phone is on the same Wi-Fi as the host Mac. Install cloudflared or set [dashboard] external_url to get a public link.`,
            );
          }
          lines.push("");
          lines.push(
            "Send this URL to the user (send_message with a short 'circle what you want changed and hit send' note). When they submit, your session will be automatically re-invoked with the annotated image and their comment — respond to that turn as you would any iMessage.",
          );
          lines.push("");
          lines.push(
            "If the user says the link stopped working (they didn't click in time, or got distracted), just call this tool again to generate a fresh one. Old links become dead once used or expired.",
          );

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } finally {
          store.close();
        }
      },
    },
  ];
}

/** Extensions browsers render natively in an `<img>` element. Everything else gets transcoded. */
const BROWSER_NATIVE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

/**
 * If `source` is already a web-native format, return it unchanged. Otherwise
 * transcode to JPEG via macOS `sips` into `<sandbox>/.annotate-cache/` and
 * return the cache path. Cached by source filename so repeat links on the
 * same image don't re-run sips.
 */
function ensureBrowserFriendly(source: string, sandboxPath: string): string {
  const ext = extname(source).toLowerCase();
  if (BROWSER_NATIVE.has(ext)) return source;

  const cacheDir = join(sandboxPath, ".annotate-cache");
  mkdirSync(cacheDir, { recursive: true });
  const base = source.split("/").pop() ?? "image";
  const outPath = join(cacheDir, `${base}.jpg`);
  if (existsSync(outPath)) {
    console.log(`[annotate] using cached jpeg for ${base}: ${outPath}`);
    return outPath;
  }

  console.log(`[annotate] transcoding ${ext} → jpeg: ${source}`);
  try {
    const res = spawnSync("sips", ["-s", "format", "jpeg", source, "--out", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (res.status !== 0) {
      console.error(
        `[annotate] sips transcode failed (status=${res.status}): ${String(res.stderr ?? "").slice(0, 200)}`,
      );
      return source;
    }
    console.log(`[annotate] transcoded ${base} → ${outPath}`);
    return existsSync(outPath) ? outPath : source;
  } catch (err) {
    console.error(`[annotate] sips exec failed: ${String(err).slice(0, 200)}`);
    return source;
  }
}

type TunnelAttempt = { ok: true; url: string; managerPid: number } | { ok: false; reason: string };

async function tryStartTunnel(port: number, ttlSec: number): Promise<TunnelAttempt> {
  try {
    const t = await startQuickTunnel(port, ttlSec);
    return { ok: true, url: t.url, managerPid: t.managerPid };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Best-effort handle for the receiver of the re-invocation. The session key
 * shape is `imessage:dm:+1555...` or `imessage:group:...` — we only have a
 * clean handle for DMs. Groups resolve via contacts at envelope-build time
 * when the synthetic cron fires, so null is fine here.
 */
function pickSenderHandle(ctx: ToolContext): string | null {
  const m = ctx.sessionKey.match(/^imessage:dm:(.+)$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Fallback base URL when cloudflared isn't available. Honors
 * `config.dashboard.external_url` if the operator has a permanent tunnel
 * of their own; otherwise picks the first non-internal LAN IP.
 */
function resolveLanBaseUrl(ctx: ToolContext): string {
  const explicit = ctx.config.dashboard.external_url.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = ctx.config.dashboard.port;
  const lan = firstLanAddress();
  if (lan) return `http://${lan}:${port}`;
  return `http://127.0.0.1:${port}`;
}

function firstLanAddress(): string | null {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}
