/**
 * PIN auth + HMAC-signed cookie.
 *
 * - PIN hash lives in config.toml under `[dashboard] pin_hash`. Hashed with
 *   Bun.password (argon2id by default).
 * - Server-side secret used to sign cookies lives at `data/dashboard.secret`.
 *   Auto-created with 0600 permissions on first boot.
 * - Cookie payload is `base64url({v:1, sub:"user", exp:<ms>})`. Signature is
 *   hex HMAC-SHA256 of the payload using the secret.
 */

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadOrCreateSecret(dataDir: string): Buffer {
  const secretPath = join(dataDir, "dashboard.secret");
  if (existsSync(secretPath)) {
    return Buffer.from(readFileSync(secretPath, "utf8").trim(), "hex");
  }
  const secret = randomBytes(32);
  writeFileSync(secretPath, secret.toString("hex"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(secretPath, 0o600);
  } catch {}
  return secret;
}

export type SessionPayload = { v: 1; sub: string; exp: number };

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((s.length + 2) % 4);
  return Buffer.from(padded, "base64");
}

export function signSession(payload: SessionPayload, secret: Buffer): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

export function verifySession(cookie: string, secret: Buffer): SessionPayload | null {
  const dot = cookie.indexOf(".");
  if (dot < 0) return null;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as SessionPayload;
    if (payload.v !== 1 || typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  if (!pinHash) return false;
  if (!pin) return false;
  try {
    return await Bun.password.verify(pin, pinHash);
  } catch {
    return false;
  }
}

export async function hashPin(pin: string): Promise<string> {
  return Bun.password.hash(pin, { algorithm: "argon2id" });
}

export const COOKIE_NAME = "edh_session";

/**
 * The dashboard cookie is first-party only (the portal uses signed URL
 * tokens, never this cookie), so SameSite=Strict costs nothing. `Secure` is
 * added when the request itself arrived over TLS; a LAN dashboard on plain
 * http cannot carry it or the browser would drop the cookie.
 */
export function buildCookie(value: string, days: number, secure = false): string {
  const maxAge = Math.max(1, Math.floor(days * 24 * 3600));
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${maxAge}`;
}

export function clearCookie(secure = false): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;
}

/** Did this request arrive over TLS, directly or through a trusting proxy? */
export function requestIsSecure(req: {
  url: string;
  header: (name: string) => string | undefined;
}): boolean {
  const proto = req.header("x-forwarded-proto");
  if (proto) return proto.split(",")[0]?.trim().toLowerCase() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function readCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === COOKIE_NAME) return rest.join("=");
  }
  return null;
}
