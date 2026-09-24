#!/usr/bin/env bun
/**
 * The kitchen host, run by launchd (com.edmund-harness.kitchen-host). See
 * src/host.ts for why it exists.
 *
 * Every SYNC_MS it reads the registry and keeps one share server running per
 * hosted household, on that household's port with its key pinned, restarting
 * any that died. It routes requests to them by `?key=`, runs the named tunnel
 * when its token file exists, and every CHECK_MS fetches each site through the
 * public URL, recording what it found in host.json.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { baseDir } from "../src/accounts.ts";
import {
  type HostStatus,
  type Hosted,
  hosted,
  readStatus,
  route,
  writeStatus,
} from "../src/host.ts";
import { dataDir, hostPort, loadKitchenSettings, siteOrigin } from "../src/settings.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SYNC_MS = 10_000;
const CHECK_MS = 60_000;
const CHECK_TIMEOUT_MS = 15_000;
/** A server that dies this soon after starting is failing, not finished. */
const QUICK_EXIT_MS = 10_000;

const config = loadKitchenSettings(join(ROOT, "config.toml"));
// Tests run a host against a scratch registry without touching the live one.
const origin =
  process.env.KITCHEN_SITE_ORIGIN !== undefined
    ? process.env.KITCHEN_SITE_ORIGIN || null
    : siteOrigin();
const routerPort = Number(process.env.KITCHEN_HOST_PORT) || hostPort();
const server = join(ROOT, "skills", "instant-share", "scripts", "secure_server.py");
const shareConfig = join(baseDir(), "host-share");
mkdirSync(shareConfig, { recursive: true, mode: 0o700 });
const tokenFile = join(dataDir(), "kitchen-tunnel-token");

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

type Child = { h: Hosted; proc: Subprocess; started: number; quickExits: number; retryAt: number };
const children = new Map<string, Child>();
let current: Hosted[] = [];
const previous = readStatus();
const status: HostStatus = {
  updatedAt: new Date().toISOString(),
  origin,
  tunnel: { pid: null, restarts: 0 },
  households: previous?.households ?? {},
};

/**
 * A share server still holding this port from before (the host was killed
 * outright, so its children outlived it) would make every start fail. Only a
 * share server is cleared; anything else on the port is left and reported.
 */
function freePort(port: number): void {
  const lsof = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  for (const pid of lsof.stdout.toString().split("\n").filter(Boolean).map(Number)) {
    const ps = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)]);
    if (ps.stdout.toString().includes("secure_server.py")) {
      process.kill(pid, "SIGKILL");
      log(`cleared a leftover share server (pid ${pid}) from :${port}`);
    } else {
      log(`:${port} is held by something else (pid ${pid}); that household cannot start`);
    }
  }
}

function start(h: Hosted, quickExits = 0): Child {
  if (!children.get(h.id) || children.get(h.id)?.proc.exitCode !== null) freePort(h.port);
  const proc = Bun.spawn(["python3", server, h.artifact, String(h.port), "0"], {
    env: {
      ...process.env,
      INSTANT_SHARE_TOKEN: h.key,
      INSTANT_SHARE_ARTIFACT_ID: `kitchen-${h.id}`,
      INSTANT_SHARE_CONFIG_DIR: shareConfig,
      INSTANT_SHARE_ADMIN_PASSWORD: config?.instant_share?.admin_password ?? "",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  log(`started ${h.id} on :${h.port} pid=${proc.pid}`);
  return { h, proc, started: Date.now(), quickExits, retryAt: 0 };
}

const same = (a: Hosted, b: Hosted) =>
  a.artifact === b.artifact && a.key === b.key && a.port === b.port;

/** Bring the running servers in line with the registry. */
function sync(): void {
  try {
    current = hosted();
  } catch (e) {
    log(`could not read the registry: ${(e as Error).message}`);
    return;
  }
  const now = Date.now();
  for (const h of current) {
    const c = children.get(h.id);
    if (c && same(c.h, h) && c.proc.exitCode === null && !c.proc.killed) continue;
    if (c && same(c.h, h) && now < c.retryAt) continue;
    if (c && !same(c.h, h)) c.proc.kill();
    if (!existsSync(join(h.artifact, "index.html"))) {
      status.households[h.id] = {
        ...blank(h),
        lastError: { at: new Date().toISOString(), why: `${h.artifact} has no index.html` },
      };
      continue;
    }
    // A server that keeps dying at once backs off to a minute between tries.
    const died = c && same(c.h, h) ? c : null;
    const quick = died && now - died.started < QUICK_EXIT_MS ? died.quickExits + 1 : 0;
    if (died) log(`${h.id} server exited (code ${died.proc.exitCode}); restarting`);
    const next = start(h, quick);
    if (quick >= 3) next.retryAt = now + 60_000;
    children.set(h.id, next);
    setTimeout(() => void check(h), 2_000);
  }
  for (const [id, c] of children) {
    if (!current.some((h) => h.id === id)) {
      c.proc.kill();
      children.delete(id);
      delete status.households[id];
      log(`stopped ${id}: no longer hosted`);
    }
  }
  for (const h of current) {
    const s = entry(h);
    s.port = h.port;
    s.pid = children.get(h.id)?.proc.pid ?? null;
  }
  status.updatedAt = new Date().toISOString();
  writeStatus(status);
}

function blank(h: Hosted) {
  return { port: h.port, pid: null, lastOk: null, lastError: null };
}

/** This household's entry in the status, created on first use. */
function entry(h: Hosted) {
  status.households[h.id] ??= blank(h);
  return status.households[h.id]!;
}

/** Fetch the page the way a household would, and record what came back. */
async function check(h: Hosted): Promise<void> {
  const base = origin ?? `http://127.0.0.1:${routerPort}`;
  const at = new Date().toISOString();
  const s = entry(h);
  try {
    const res = await fetch(`${base}/?key=${h.key}`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = await res.text();
    if (res.ok && body.includes("<html")) s.lastOk = at;
    else s.lastError = { at, why: `HTTP ${res.status}` };
  } catch (e) {
    s.lastError = { at, why: (e as Error).message };
  }
  status.updatedAt = new Date().toISOString();
  writeStatus(status);
}

/* ── the router ──────────────────────────────────────────────────────────── */

Bun.serve({
  hostname: "127.0.0.1",
  port: routerPort,
  async fetch(req) {
    const url = new URL(req.url);
    const h = route(url, current);
    if (!h) return new Response("Not found", { status: 404 });
    const headers = new Headers(req.headers);
    headers.delete("host");
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
        decompress: false,
      } as RequestInit);
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch {
      return new Response("This kitchen page is restarting. Try again in a minute.", {
        status: 502,
      });
    }
  },
});
log(`router on 127.0.0.1:${routerPort}, publishing at ${origin ?? "(no site_origin set)"}`);

/* ── the tunnel ──────────────────────────────────────────────────────────── */

let tunnel: Subprocess | null = null;
function runTunnel(): void {
  if (!existsSync(tokenFile)) {
    log(`no ${tokenFile}; serving locally only`);
    return;
  }
  const bin = existsSync("/opt/homebrew/bin/cloudflared")
    ? "/opt/homebrew/bin/cloudflared"
    : "cloudflared";
  const started = Date.now();
  tunnel = Bun.spawn([bin, "tunnel", "--no-autoupdate", "run", "--token-file", tokenFile], {
    stdout: "ignore",
    stderr: "ignore",
  });
  status.tunnel.pid = tunnel.pid;
  log(`tunnel pid=${tunnel.pid}`);
  void tunnel.exited.then((code) => {
    status.tunnel.pid = null;
    status.tunnel.restarts++;
    const wait = Date.now() - started < 60_000 ? 30_000 : 5_000;
    log(`tunnel exited (code ${code}); restarting in ${wait / 1000}s`);
    setTimeout(runTunnel, wait);
  });
}

function shutdown(): void {
  for (const c of children.values()) c.proc.kill();
  tunnel?.kill();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

sync();
runTunnel();
setInterval(sync, SYNC_MS);
setInterval(() => {
  for (const h of current) void check(h);
}, CHECK_MS);
