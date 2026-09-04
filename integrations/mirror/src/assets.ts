import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import { mirrorConfig } from "../config.ts";
import { type ImageTreatment, measuredTreatment } from "./luminance.ts";
import type { MirrorComponentSpec } from "./protocol.ts";

const MAX_ASSET_BYTES = 24 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

export type PublishedMirrorAsset = {
  url: string;
  name: string;
  mime: string;
  size: number;
  /**
   * How bright this image actually is, measured rather than declared.
   *
   * Absent when it could not be measured, which is honest: "I could not tell"
   * and "it is a photo" are different claims and should not share a value.
   */
  treatment?: ImageTreatment;
};

export async function publishMirrorAsset(
  filePath: string,
  config: Config,
): Promise<PublishedMirrorAsset> {
  const stats = statSync(filePath);
  if (!stats.isFile()) throw new Error("mirror asset path is not a regular file");
  if (stats.size <= 0) throw new Error("mirror asset is empty");
  if (stats.size > MAX_ASSET_BYTES) {
    throw new Error(`mirror asset exceeds ${MAX_ASSET_BYTES / 1024 / 1024} MiB`);
  }
  const bytes = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  // Measured here, once, while the bytes are in hand — not asked of the model
  // and not re-derived per render. A map is a white field with a little ink on
  // it and a photograph is not, and that difference is worth nearly three
  // stops of brightness on a mirror in a dark room.
  const treatment = mime.startsWith("image/") ? measuredTreatment(filePath) : null;
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  const safeExt = /^[.][a-z0-9]{1,8}$/.test(ext) ? ext : "";
  const name = `${hash}${safeExt}`;
  const url = `http://${mirrorConfig(config).host}:${mirrorConfig(config).port}/asset?name=${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mirrorConfig(config).token}`,
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
    },
    body: bytes,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    url?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || payload?.ok !== true || typeof payload.url !== "string") {
    const detail =
      typeof payload?.error === "string" ? payload.error.slice(0, 200) : `HTTP ${response.status}`;
    throw new Error(`mirror asset upload failed: ${detail}`);
  }
  return {
    url: payload.url,
    name,
    mime,
    size: bytes.length,
    ...(treatment ? { treatment } : {}),
  };
}

export function mirrorComponentForAsset(
  asset: PublishedMirrorAsset,
  caption?: string,
  sourcePath?: string,
): MirrorComponentSpec {
  const title = caption?.trim() || basename(sourcePath ?? asset.name);
  if (asset.mime.startsWith("image/")) {
    return {
      component: "image_card",
      props: {
        src: asset.url,
        alt: title || basename(sourcePath ?? asset.name),
        ...(title ? { caption: title } : {}),
        fit: "contain",
        // Measured upstream, not guessed. This used to hard-code "photo" on
        // the reasoning that someone asking to SEE a file is usually showing a
        // picture — true, and wrong for exactly the case that matters, a
        // generated chart pushed the same way. Falling back to "photo" only
        // when the measurement failed keeps the old behaviour for images this
        // machine cannot decode.
        treatment: asset.treatment ?? "photo",
      },
    };
  }
  if (asset.mime.startsWith("video/")) {
    return {
      component: "video",
      props: {
        src: asset.url,
        title,
        autoplay: true,
        muted: true,
        loop: false,
      },
    };
  }
  if (asset.mime.startsWith("audio/")) {
    return {
      component: "audio",
      props: {
        src: asset.url,
        title,
        autoplay: false,
        muted: false,
        loop: false,
      },
    };
  }
  return {
    component: "file_card",
    props: {
      name: basename(sourcePath ?? asset.name),
      url: asset.url,
      mime: asset.mime,
      sizeLabel: humanBytes(asset.size),
      ...(title ? { caption: title } : {}),
    },
  };
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
