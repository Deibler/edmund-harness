import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import twilio from "twilio";
import { maybeResizeImage } from "../media/image-resize.ts";
import { maybePrepareVideoForSend } from "../media/video-transcode.ts";
import { log } from "../util/log.ts";
import type { TwilioCreds } from "./client.ts";

/**
 * Inbound media over SMS: what Twilio actually delivers and how to get it.
 *
 * Measured on the live account (2026-11-03), not taken from the docs:
 *
 *  - **Each photo is its own Conversations message, with an empty body.** A
 *    text-plus-photo MMS arrives as two messages in the same second; a
 *    two-photo MMS as two one-photo messages. A handler that returns on an
 *    empty body drops every photo, and one did: 9 of 9 since September.
 *  - **The REST record is the source of truth for what is attached.** Its
 *    `media` array is snake_case (`sid`, `content_type`, `filename`, `size`,
 *    `category`). The webhook's `Media` field is documented only as a
 *    "stringified JSON array" with no example, and Twilio's own support note
 *    says it can list just one item of several, so it is never parsed here.
 *  - **Bytes come from the Media Content Service, in two steps.** An
 *    authenticated `GET mcs.us1.twilio.com/v1/Services/{IS}/Media/{ME}`
 *    returns `links.content_direct_temporary`, a signed media.us1 URL that
 *    serves the file WITHOUT auth and expires 300 seconds after it is issued,
 *    so it is fetched immediately. The API key works for the first step. The
 *    SDK has no method for MCS, so these two requests are plain HTTP; the
 *    message lookup goes through the SDK.
 */

export type SmsMedia = {
  sid: string;
  contentType: string;
  filename: string | null;
  size: number | null;
};

/** Looks up the raw `media` array of one Conversations message (null = no record). */
export type FetchMessageMedia = (
  conversationSid: string,
  messageSid: string,
) => Promise<unknown[] | null>;

/** Twilio's stated ceiling is 5 MB per MMS; anything far past it is not a photo from a phone. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** Downloaded files are copied into the session sandbox by the turn; this is only a staging area. */
const STAGING_TTL_MS = 14 * 24 * 3_600_000;

/** The SDK-backed lookup used in production. */
export function sdkMessageMediaFetcher(creds: TwilioCreds): FetchMessageMedia {
  const client = twilio(creds.keySid, creds.keySecret, { accountSid: creds.accountSid });
  return async (conversationSid, messageSid) => {
    const msg = await client.conversations.v1
      .conversations(conversationSid)
      .messages(messageSid)
      .fetch();
    return Array.isArray(msg.media) ? (msg.media as unknown[]) : [];
  };
}

/**
 * Normalize the REST `media` array. Tolerates camelCase and PascalCase keys
 * as well, so a future SDK that maps the fields does not silently turn every
 * photo back into nothing.
 */
export function parseMessageMedia(raw: unknown[] | null): SmsMedia[] {
  if (!raw) return [];
  const out: SmsMedia[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const sid = o.sid ?? o.Sid;
    if (typeof sid !== "string" || !sid.startsWith("ME")) continue;
    const contentType = o.content_type ?? o.contentType ?? o.ContentType;
    const filename = o.filename ?? o.Filename;
    const size = o.size ?? o.Size;
    out.push({
      sid,
      contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
      filename: typeof filename === "string" && filename ? filename : null,
      size: typeof size === "number" ? size : null,
    });
  }
  return out;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "video/quicktime": ".mov",
  "audio/amr": ".amr",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "text/vcard": ".vcf",
  "text/x-vcard": ".vcf",
  "application/pdf": ".pdf",
};

/** File extension for a media item: the content type first, then the filename. */
function extensionFor(m: SmsMedia): string {
  const byType = EXT_BY_TYPE[m.contentType.toLowerCase().split(";")[0]!.trim()];
  if (byType) return byType;
  const fromName = m.filename ? extname(m.filename).toLowerCase() : "";
  return /^\.[a-z0-9]{1,5}$/.test(fromName) ? fromName : ".bin";
}

/** A word for the transcript: "photo", "video", "voice memo", "file". */
export function mediaNoun(m: Pick<SmsMedia, "contentType">): string {
  const t = m.contentType.toLowerCase();
  if (t.startsWith("image/")) return "photo";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "voice memo";
  if (t.includes("vcard")) return "contact card";
  return "file";
}

/**
 * Download one media item to `destDir`, returning the local path or null.
 * Never throws: a failed download is reported to the model by the caller,
 * which is better than an exception that drops the whole message.
 */
export async function downloadMedia(params: {
  creds: TwilioCreds;
  chatServiceSid: string;
  media: SmsMedia;
  destDir: string;
}): Promise<string | null> {
  const { creds, chatServiceSid, media, destDir } = params;
  const auth = `Basic ${Buffer.from(`${creds.keySid}:${creds.keySecret}`).toString("base64")}`;
  try {
    const metaRes = await fetch(
      `https://mcs.us1.twilio.com/v1/Services/${chatServiceSid}/Media/${media.sid}`,
      { headers: { Authorization: auth } },
    );
    if (!metaRes.ok) {
      log.warn("sms", "media lookup failed", { media: media.sid, status: metaRes.status });
      return null;
    }
    const meta = (await metaRes.json()) as { links?: { content_direct_temporary?: string } };
    const signed = meta.links?.content_direct_temporary;
    if (!signed?.startsWith("https://")) {
      log.warn("sms", "media lookup had no download link", { media: media.sid });
      return null;
    }
    // The signed link carries its own authorization; sending ours to the
    // CDN host would hand the API key to a second origin for nothing.
    const res = await fetch(signed);
    if (!res.ok) {
      log.warn("sms", "media download failed", { media: media.sid, status: res.status });
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
      log.warn("sms", "media size out of range", { media: media.sid, bytes: bytes.length });
      return null;
    }
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const path = join(destDir, `${media.sid}${extensionFor(media)}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  } catch (err) {
    log.warn("sms", "media download error", { media: media.sid, err: String(err) });
    return null;
  }
}

/** Remove staged downloads older than the TTL. Cheap enough to run on each download. */
export function pruneStagedMedia(destDir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(destDir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(destDir, name);
    try {
      if (now - statSync(p).mtimeMs > STAGING_TTL_MS) rmSync(p, { force: true });
    } catch {
      // A file that vanished between readdir and stat is already pruned.
    }
  }
}

// ── outbound ─────────────────────────────────────────────────────────────

/**
 * What an MMS can carry, by extension. From Twilio's accepted-MIME table
 * (messaging/guides/accepted-mime-types): images, most audio and video,
 * vCard/CSV/calendar text and PDF. WebP and Office documents are NOT
 * supported for MMS. Formats the handset may not render (HEIC, TIFF, BMP,
 * WebP) are converted to JPEG first rather than trusted to the carrier.
 */
const MMS_TYPE_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".amr": "audio/amr",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".vcf": "text/vcard",
  ".csv": "text/csv",
  ".ics": "text/calendar",
  ".pdf": "application/pdf",
};
const CONVERT_TO_JPEG = new Set([".heic", ".heif", ".webp", ".tiff", ".tif", ".bmp"]);
/** Twilio's MMS ceiling is 5 MB for the message and its media together; a
 *  caption is a few hundred bytes, so the file keeps a margin under it. */
const MMS_MAX_FILE_BYTES = 4_500_000;
const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".3gp", ".webm", ".mkv", ".avi"]);

export type PreparedMms =
  | { ok: true; path: string; contentType: string; converted: boolean }
  | { ok: false; reason: string };

/**
 * Make a file sendable as MMS, or say why it can't be. Never sends anything.
 * A file MMS cannot carry (a doc, a zip, a web page) gets a reason the model
 * can act on: publish it and text the link.
 */
export async function prepareForMms(path: string): Promise<PreparedMms> {
  const ext = extname(path).toLowerCase();
  let out = path;
  if (CONVERT_TO_JPEG.has(ext)) {
    // Size floor of 1 byte forces the JPEG conversion even for small files.
    out = await maybeResizeImage(path, 2048, 1);
  } else if (ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    out = await maybeResizeImage(path, 2048, MMS_MAX_FILE_BYTES);
  } else if (VIDEO_EXTS.has(ext)) {
    out = await maybePrepareVideoForSend(path, MMS_MAX_FILE_BYTES);
  }
  const contentType = MMS_TYPE_BY_EXT[extname(out).toLowerCase()];
  if (!contentType) {
    return {
      ok: false,
      reason: `MMS can't carry a ${ext || "file without an extension"} file. Publish it (shelve) and text the link instead.`,
    };
  }
  let size: number;
  try {
    size = statSync(out).size;
  } catch {
    return { ok: false, reason: `no such file: ${path}` };
  }
  if (size > MMS_MAX_FILE_BYTES) {
    return {
      ok: false,
      reason: `the file is ${(size / 1e6).toFixed(1)} MB after preparing it, and MMS stops at 5 MB. Publish it (shelve) and text the link instead.`,
    };
  }
  return { ok: true, path: out, contentType, converted: out !== path };
}

/** The Conversations calls an outbound media send makes. Injectable for tests. */
export type ConversationMediaApi = {
  /** The Chat Service a Conversation lives in; its media goes to that service's MCS. */
  chatServiceSid: (conversationSid: string) => Promise<string>;
  /** Post one message carrying an uploaded media item (and optional body); returns its IM sid. */
  postMedia: (args: {
    conversationSid: string;
    author: string;
    mediaSid: string;
    body?: string;
  }) => Promise<string>;
};

export function sdkConversationMediaApi(creds: TwilioCreds): ConversationMediaApi {
  const client = twilio(creds.keySid, creds.keySecret, { accountSid: creds.accountSid });
  const services = new Map<string, string>();
  return {
    chatServiceSid: async (conversationSid) => {
      const known = services.get(conversationSid);
      if (known) return known;
      const conv = await client.conversations.v1.conversations(conversationSid).fetch();
      services.set(conversationSid, conv.chatServiceSid);
      return conv.chatServiceSid;
    },
    postMedia: async ({ conversationSid, author, mediaSid, body }) => {
      const msg = await client.conversations.v1.conversations(conversationSid).messages.create({
        author,
        mediaSid,
        ...(body ? { body } : {}),
      });
      return msg.sid;
    },
  };
}

/**
 * Upload a file to the Media Content Service and return its ME sid. Measured
 * 2026-11-03: the API key authenticates the POST (201), and the response is
 * `{ sid, service_sid, size, content_type, ... }`. An upload not attached to
 * a message within five minutes is garbage-collected by Twilio, so callers
 * post the message right after.
 */
export async function uploadMedia(params: {
  creds: TwilioCreds;
  chatServiceSid: string;
  path: string;
  contentType: string;
}): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const { creds, chatServiceSid, path, contentType } = params;
  const auth = `Basic ${Buffer.from(`${creds.keySid}:${creds.keySecret}`).toString("base64")}`;
  try {
    const res = await fetch(`https://mcs.us1.twilio.com/v1/Services/${chatServiceSid}/Media`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": contentType },
      body: readFileSync(path),
    });
    if (!res.ok) return { ok: false, error: `media upload failed (HTTP ${res.status})` };
    const json = (await res.json()) as { sid?: unknown };
    if (typeof json.sid !== "string" || !json.sid.startsWith("ME")) {
      return { ok: false, error: "media upload returned no media sid" };
    }
    return { ok: true, sid: json.sid };
  } catch (err) {
    return { ok: false, error: `media upload error: ${String(err)}` };
  }
}
