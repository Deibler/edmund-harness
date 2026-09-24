/**
 * The kitchen host: every household's site at one permanent address.
 *
 * Sites used to be shared through Cloudflare quick tunnels, whose hostname
 * changes whenever the tunnel restarts. On this Mac that is every reboot and
 * every few days besides, so a link sent to a household was usually dead
 * within the week, and nothing noticed. The host (`scripts/host.ts`, one
 * launchd service) keeps a share server running for each household on a fixed
 * local port, a router in front of them, and a named tunnel to the router.
 *
 * The router picks the household by the `?key=` every request from the site
 * already carries, so pages need no path prefix and adding a household needs
 * no DNS change. The registry holds each hosted household's key and port; the
 * host writes what it found to `host.json`, and "is the site live" reads that,
 * never the registry's URL.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseDir, getAccount, loadRegistry, updateAccount } from "./accounts.ts";
import type { Account, Registry } from "./types.ts";

/** Local ports the share servers use, one per household. */
export const PORTS = { first: 4801, last: 4899 } as const;

/** A check older than this says nothing about now: the host itself may be down. */
export const STATUS_FRESH_MS = 5 * 60_000;

export type Hosted = { id: string; artifact: string; key: string; port: number };

/** Households the host serves: each has an artifact directory, a key and a port. */
export function hosted(reg: Registry = loadRegistry()): Hosted[] {
  const out: Hosted[] = [];
  for (const [id, acct] of Object.entries(reg.tenants)) {
    const s = acct.site;
    if (s?.artifact && s.key && typeof s.port === "number") {
      out.push({ id, artifact: s.artifact, key: s.key, port: s.port });
    }
  }
  return out;
}

/** The lowest port in PORTS no household holds. */
export function freePort(reg: Registry = loadRegistry()): number {
  const taken = new Set(hosted(reg).map((h) => h.port));
  for (let p = PORTS.first; p <= PORTS.last; p++) if (!taken.has(p)) return p;
  throw new Error(`every kitchen host port from ${PORTS.first} to ${PORTS.last} is taken`);
}

/** The household a request is for, by the key in its query. Null for anything else. */
export function route(url: URL, households: Hosted[]): Hosted | null {
  const key = url.searchParams.get("key") ?? url.searchParams.get("token");
  if (!key) return null;
  return households.find((h) => h.key === key) ?? null;
}

export type Published = { url: string; key: string; port: number; previous: string | null };

/**
 * Put a household's rendered site on the host: keep its key and port if it has
 * them, otherwise mint a key and take a free port, and record the permanent
 * URL. Idempotent. The host picks the change up on its next pass; `siteStatus`
 * says when it is actually answering.
 */
export function publish(id: string, origin: string): Published {
  const acct = getAccount(id);
  if (!acct) throw new Error(`No household "${id}".`);
  const artifact = acct.site?.artifact;
  if (!artifact || !existsSync(join(artifact, "index.html"))) {
    throw new Error(`"${id}" has no rendered site yet; render it first.`);
  }
  const key = acct.site?.key ?? randomBytes(24).toString("base64url");
  const port = acct.site?.port ?? freePort();
  const url = `${origin.replace(/\/+$/, "")}/?key=${key}`;
  const previous = acct.site?.url && acct.site.url !== url ? acct.site.url : null;
  updateAccount(id, { site: { artifact, key, port, url } } as Partial<Account>);
  ensureManifest(artifact, id);
  return { url, key, port, previous };
}

/** The share server names its artifact from this file; give it one if missing. */
function ensureManifest(artifact: string, id: string): void {
  const path = join(artifact, "artifact.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing or unreadable: write a fresh one.
  }
  if (manifest.artifact_id) return;
  manifest.artifact_id = `kitchen-${id}`;
  manifest.name ??= `${id} kitchen`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/* ── what the host found ─────────────────────────────────────────────────── */

export type HouseholdStatus = {
  port: number;
  /** The share server's pid, when it is running. */
  pid: number | null;
  /** Last time the page answered through the public URL. */
  lastOk: string | null;
  /** Last time it did not, and why. */
  lastError: { at: string; why: string } | null;
};

export type HostStatus = {
  updatedAt: string;
  origin: string | null;
  tunnel: { pid: number | null; restarts: number };
  households: Record<string, HouseholdStatus>;
};

export function statusPath(): string {
  return join(baseDir(), "host.json");
}

export function readStatus(): HostStatus | null {
  try {
    return JSON.parse(readFileSync(statusPath(), "utf8")) as HostStatus;
  } catch {
    return null;
  }
}

export function writeStatus(status: HostStatus): void {
  const tmp = `${statusPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(tmp, statusPath());
}

export type SiteStatus =
  | { state: "live"; url: string; checked: string }
  | { state: "down"; url: string; why: string }
  | { state: "unhosted"; url: string | null };

/**
 * Whether a household's site answers, from the host's own checks through the
 * public URL. A hosted site with no recent check is down: either the host is
 * not running or it has not reached the page yet.
 */
export function siteStatus(
  acct: Account & { id: string },
  now = Date.now(),
  status = readStatus(),
): SiteStatus {
  const s = acct.site;
  if (!s?.key || typeof s.port !== "number" || !s.url) {
    return { state: "unhosted", url: s?.url ?? null };
  }
  if (!status || now - Date.parse(status.updatedAt) > STATUS_FRESH_MS) {
    return { state: "down", url: s.url, why: "the kitchen host is not running" };
  }
  const h = status.households[acct.id];
  if (!h) return { state: "down", url: s.url, why: "the kitchen host has not picked it up yet" };
  const ok = h.lastOk ? Date.parse(h.lastOk) : 0;
  const bad = h.lastError ? Date.parse(h.lastError.at) : 0;
  if (ok && ok >= bad && now - ok <= STATUS_FRESH_MS) {
    return { state: "live", url: s.url, checked: h.lastOk! };
  }
  return { state: "down", url: s.url, why: h.lastError?.why ?? "not answering yet" };
}

/** Wait for the host to report the site live, polling its status file. */
export async function waitLive(
  id: string,
  timeoutMs = 45_000,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<SiteStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const acct = getAccount(id);
    if (!acct) throw new Error(`No household "${id}".`);
    const s = siteStatus({ ...acct, id });
    if (s.state === "live" || Date.now() >= deadline) return s;
    await sleep(1_000);
  }
}
