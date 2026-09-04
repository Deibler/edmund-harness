/**
 * User self-service portal links.
 *
 * Every user gets a STANDING personal URL (sent at the bottom of each
 * proactive message) where they can tune Edmund's proactive behavior for
 * themselves: on/off, allowed hours, a note to the ghost, and their
 * scheduled jobs. No PIN — the link itself is the credential:
 *
 *   /u/<b64url(sessionKey)>/<hmac(secret, "portal:"+sessionKey)>
 *
 * The token is permanent by default: anyone holding the exact link controls
 * that ONE chat's settings and nothing else. It can be revoked per session
 * (`edmund portal revoke <handle>`), which changes the link. The secret is the dashboard's existing data/dashboard.secret.
 * Verification is constant-time; the portal routes add per-IP rate
 * limiting on top.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config.ts";

/**
 * The same secret the dashboard uses for its auth cookies
 * (data/dashboard.secret) — daemon and dashboard must derive identical
 * portal tokens, so they read the same file. Created here if the
 * dashboard has never booted.
 */
export function loadPortalSecret(dataDir: string): Buffer {
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

export function b64urlEncode(s: string): string {
  return Buffer.from(s)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function b64urlDecode(s: string): string | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((s.length + 2) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Revocation. A link is permanent by design (it is printed at the bottom of
 * messages people keep), so revoking one means changing what the current
 * link IS: every session has a generation, and the token is an HMAC over
 * the key plus the generation. Bumping the generation kills every link
 * issued before it; the next message carries the new one. Generation 0 is
 * the original, un-numbered format, so links from before this existed keep
 * working until their session is revoked.
 *
 * The daemon (which builds links) and the dashboard (which verifies them)
 * are different processes, so the generations live in a small JSON file in
 * the data directory that both read on every use.
 */
const GENERATIONS_FILE = "portal-generations.json";

function loadPortalGenerations(dataDir: string): Record<string, number> {
  try {
    const raw = readFileSync(join(dataDir, GENERATIONS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function portalGeneration(dataDir: string, sessionKey: string): number {
  return loadPortalGenerations(dataDir)[sessionKey] ?? 0;
}

/** Invalidate every link issued so far for this session. Returns the new generation. */
export function revokePortalLinks(dataDir: string, sessionKey: string): number {
  const all = loadPortalGenerations(dataDir);
  const next = (all[sessionKey] ?? 0) + 1;
  all[sessionKey] = next;
  const path = join(dataDir, GENERATIONS_FILE);
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
  return next;
}

export function portalToken(secret: Buffer, sessionKey: string, generation = 0): string {
  const input = generation > 0 ? `portal:${sessionKey}:${generation}` : `portal:${sessionKey}`;
  return createHmac("sha256", secret).update(input).digest("hex").slice(0, 40);
}

export function portalPath(secret: Buffer, sessionKey: string, generation = 0): string {
  return `/u/${b64urlEncode(sessionKey)}/${portalToken(secret, sessionKey, generation)}`;
}

/**
 * Recover + verify the sessionKey from URL parts. null on any mismatch.
 * Pass the data directory so the session's current generation is honoured;
 * without it only generation 0 links verify.
 */
export function verifyPortalParts(
  secret: Buffer,
  encodedKey: string,
  token: string,
  dataDir?: string,
): string | null {
  const sessionKey = b64urlDecode(encodedKey);
  if (!sessionKey || sessionKey.length > 200) return null;
  const generation = dataDir ? portalGeneration(dataDir, sessionKey) : 0;
  const expected = portalToken(secret, sessionKey, generation);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return sessionKey;
}

/**
 * Public base for phone-openable links, in preference order:
 *   1. [dashboard] external_url — operator's own permanent tunnel/domain
 *   2. data/portal-tunnel-url   — the LIVE TryCloudflare quick-tunnel URL,
 *      written by scripts/launchd/run-portal-tunnel.sh each time the
 *      tunnel (re)starts. Quick-tunnel hostnames rotate on restart, so
 *      this is read fresh at every link-build — newly sent links always
 *      point at the current tunnel; links from before a rotation die
 *      (the user just asks Edmund for a fresh one).
 *   3. LAN IP fallback — same-WiFi only.
 */
function portalBaseUrl(config: Config): string {
  const explicit = config.dashboard.external_url.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const tunnelFile = join(config.paths.data_dir, "portal-tunnel-url");
    if (existsSync(tunnelFile)) {
      const url = readFileSync(tunnelFile, "utf8").trim();
      if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) return url;
    }
  } catch {
    // unreadable file — fall through to LAN
  }
  const lan = firstLanAddress();
  const port = config.dashboard.port;
  return `http://${lan ?? "127.0.0.1"}:${port}`;
}

export function portalUrl(config: Config, secret: Buffer, sessionKey: string): string {
  const generation = portalGeneration(config.paths.data_dir, sessionKey);
  return `${portalBaseUrl(config)}${portalPath(secret, sessionKey, generation)}`;
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
