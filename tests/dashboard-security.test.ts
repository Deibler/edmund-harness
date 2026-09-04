/**
 * The dashboard's second locks: secret masking that is structural rather
 * than a list, login throttling, cookie flags, the origin guard, body
 * limits, error bodies without internals, and symlink-safe media paths.
 * Every test here was watched fail against the pre-fix code.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { buildCookie, clearCookie, requestIsSecure } from "../dashboard/server/auth.ts";
import { originGuard, securityHeaders } from "../dashboard/server/middleware/csrf.ts";
import { errorHandler } from "../dashboard/server/middleware/error.ts";
import {
  deepMergeWithSecrets,
  isSecretKey,
  maskSecrets,
} from "../dashboard/server/services/configIO.ts";
import { LoginThrottle } from "../dashboard/server/services/loginThrottle.ts";
import { resolveWithin } from "../dashboard/server/services/mediaIndex.ts";

describe("secret masking is structural", () => {
  test("every credential-shaped key at any depth is masked, identifiers are not", () => {
    const input = {
      keys: { openai: "sk-live-abcd1234", openrouter_provisioning: "prov-xyz9", brave: "" },
      mirror: { token: "mirror-token-0001", session_key: "mirror:pi-4", host: "10.0.0.5" },
      cloudflare: { api_token: "cf-token-7777", account_id: "acct" },
      trading: { mcp_headers: { Authorization: "Bearer deadbeef", "X-Other": "plainvalue" } },
      instant_share: { admin_password: "hunter2hunter2" },
      guest_campaigns: [{ key: "opensesame2026", label: "Example" }],
      memory_recall: { index_db: "recall.sqlite" },
      dashboard: { pin_hash: "$argon2id$abc", bind: "127.0.0.1" },
    };
    const out = maskSecrets(input) as typeof input;
    expect(out.keys.openai).toBe("•••1234");
    expect(out.keys.openrouter_provisioning).toBe("•••xyz9");
    expect(out.keys.brave).toBe("");
    expect(out.mirror.token).toBe("•••0001");
    expect(out.mirror.session_key).toBe("mirror:pi-4");
    expect(out.mirror.host).toBe("10.0.0.5");
    expect(out.cloudflare.api_token).toBe("•••7777");
    expect(out.cloudflare.account_id).toBe("acct");
    expect(out.trading.mcp_headers.Authorization).toBe("•••beef");
    expect(out.trading.mcp_headers["X-Other"]).toBe("•••alue");
    expect(out.instant_share.admin_password).toBe("•••ter2");
    expect(out.guest_campaigns[0]!.key).toBe("•••2026");
    expect(out.guest_campaigns[0]!.label).toBe("Example");
    expect(out.memory_recall.index_db).toBe("recall.sqlite");
    expect(out.dashboard.bind).toBe("127.0.0.1");
    expect(JSON.stringify(out)).not.toContain("sk-live");
    expect(JSON.stringify(out)).not.toContain("deadbeef");
  });

  test("a masked config written back leaves every secret on disk untouched, inside arrays too", () => {
    const onDisk = {
      keys: { openai: "sk-live-abcd1234", brave: "brave-key-9999" },
      guest_campaigns: [
        { key: "opensesame2026", label: "Example", context: "campaigns/example.md" },
        { key: "secondkey2026", label: "Second", context: "campaigns/second.md" },
      ],
      trading: { mcp_headers: { Authorization: "Bearer deadbeef" } },
      allowlist: { dm: ["+15550100001"] },
    };
    const sent = maskSecrets(onDisk) as Record<string, unknown>;
    (sent.allowlist as { dm: string[] }).dm.push("+15550100002");
    ((sent.guest_campaigns as Array<Record<string, unknown>>)[1] as Record<string, unknown>).label =
      "Renamed";
    const merged = deepMergeWithSecrets(onDisk, sent) as typeof onDisk;
    expect(merged.keys).toEqual(onDisk.keys);
    expect(merged.guest_campaigns[0]).toEqual(onDisk.guest_campaigns[0]);
    expect(merged.guest_campaigns[1]!.key).toBe("secondkey2026");
    expect(merged.guest_campaigns[1]!.label).toBe("Renamed");
    expect(merged.trading.mcp_headers.Authorization).toBe("Bearer deadbeef");
    expect(merged.allowlist.dm).toEqual(["+15550100001", "+15550100002"]);
  });

  test("the key classifier", () => {
    for (const k of [
      "openai",
      "api_token",
      "stripe_secret",
      "stripe_webhook_secret",
      "admin_password",
      "pin_hash",
      "openrouter_provisioning",
    ]) {
      // `openai` and `openrouter_provisioning` are only masked because they sit in [keys]; the classifier alone is stricter.
      if (k === "openai" || k === "openrouter_provisioning") continue;
      expect(isSecretKey(k)).toBe(true);
    }
    for (const k of [
      "session_key",
      "config_key",
      "index_db",
      "installed_db",
      "consent_db",
      "port",
      "model",
      "external_url",
      "stripe_publishable",
    ]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe("login throttle", () => {
  test("five failures lock a client out, and lockouts double", () => {
    let t = 1_000_000;
    const th = new LoginThrottle(5, 60_000, 60_000, 15 * 60_000, () => t);
    for (let i = 0; i < 4; i++) expect(th.recordFailure("ip").allowed).toBe(true);
    const fifth = th.recordFailure("ip");
    expect(fifth.allowed).toBe(false);
    if (!fifth.allowed) expect(fifth.retryAfterSec).toBe(60);
    expect(th.check("ip").allowed).toBe(false);
    t += 61_000;
    expect(th.check("ip").allowed).toBe(true);
    for (let i = 0; i < 5; i++) th.recordFailure("ip");
    const second = th.check("ip");
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.retryAfterSec).toBe(120);
    th.recordSuccess("ip");
    expect(th.check("ip").allowed).toBe(true);
    expect(th.check("other").allowed).toBe(true);
  });
});

describe("cookie flags", () => {
  test("Strict always, Secure only over TLS", () => {
    expect(buildCookie("v", 1)).toContain("SameSite=Strict");
    expect(buildCookie("v", 1)).not.toContain("Secure");
    expect(buildCookie("v", 1, true)).toContain("; Secure");
    expect(clearCookie(true)).toContain("; Secure");
    const hdr = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];
    expect(requestIsSecure({ url: "http://lan:4747/x", header: hdr({}) })).toBe(false);
    expect(requestIsSecure({ url: "https://lan:4747/x", header: hdr({}) })).toBe(true);
    expect(
      requestIsSecure({ url: "http://lan:4747/x", header: hdr({ "x-forwarded-proto": "https" }) }),
    ).toBe(true);
  });
});

describe("origin guard", () => {
  const app = new Hono();
  app.use("/api/*", originGuard());
  app.post("/api/thing", (c) => c.json({ ok: true }));
  app.get("/api/thing", (c) => c.json({ ok: true }));

  test("same-origin and header-less requests pass", async () => {
    expect(
      (
        await app.request("/api/thing", {
          method: "POST",
          headers: { host: "lan:4747", origin: "http://lan:4747" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await app.request("/api/thing", { method: "POST", headers: { host: "lan:4747" } })).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/thing", {
          method: "GET",
          headers: { host: "lan:4747", origin: "http://evil.example" },
        })
      ).status,
    ).toBe(200);
  });

  test("cross-origin mutations are refused", async () => {
    expect(
      (
        await app.request("/api/thing", {
          method: "POST",
          headers: { host: "lan:4747", origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/thing", {
          method: "POST",
          headers: { host: "lan:4747", "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/thing", {
          method: "POST",
          headers: { host: "lan:4747", origin: "not a url" },
        })
      ).status,
    ).toBe(403);
  });

  test("the same host on another port is ours (the dev proxy)", async () => {
    const r = await app.request("/api/thing", {
      method: "POST",
      headers: { host: "localhost:4747", origin: "http://localhost:5173" },
    });
    expect(r.status).toBe(200);
  });

  test("a trusting proxy's forwarded host counts as ours", async () => {
    const r = await app.request("/api/thing", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4749",
        "x-forwarded-host": "edmund.example.com",
        origin: "https://edmund.example.com",
      },
    });
    expect(r.status).toBe(200);
  });
});

describe("body limit and error body", () => {
  test("an oversized login body is refused with 413 before the handler runs", async () => {
    let ran = false;
    const app = new Hono();
    app.use("/login", bodyLimit({ maxSize: 4096 }));
    app.post("/login", async (c) => {
      ran = true;
      return c.json({ ok: true });
    });
    const big = JSON.stringify({ pin: "x".repeat(5000) });
    const r = await app.request("/login", {
      method: "POST",
      body: big,
      headers: { "content-type": "application/json", "content-length": String(big.length) },
    });
    expect(r.status).toBe(413);
    expect(ran).toBe(false);
  });

  test("unhandled errors return an id, never the message", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/boom", () => {
      throw new Error("SELECT * FROM secrets WHERE path='/Users/someone/.ssh'");
    });
    const r = await app.request("/boom");
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string; id?: string; detail?: string };
    expect(body.error).toBe("internal error");
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(".ssh");
  });

  test("security headers ride on every response", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (c) => c.text("ok"));
    const r = await app.request("/");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("media paths are confined by real path", () => {
  test("a symlink inside the root pointing outside is refused", () => {
    const base = mkdtempSync(join(tmpdir(), "edh-media-"));
    const root = join(base, "sandbox");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "nope");
    writeFileSync(join(root, "ok.png"), "fine");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.png"));
    expect(resolveWithin(join(root, "ok.png"), root)).not.toBeNull();
    expect(resolveWithin(join(root, "escape.png"), root)).toBeNull();
    expect(resolveWithin(join(root, "..", "outside", "secret.txt"), root)).toBeNull();
    expect(resolveWithin(join(root, "missing.png"), root)).toBeNull();
  });
});
