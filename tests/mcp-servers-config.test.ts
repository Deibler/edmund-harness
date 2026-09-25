/**
 * `[mcp_servers]`: MCP servers from config.toml for the assistant's workers.
 * Workers run with --strict-mcp-config, so a server added with `claude mcp
 * add` never reaches them; this is the only door. Guests never get these,
 * contacts only when a server says so, and the files that carry bearer
 * tokens are readable by this user alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type McpConfigPaths, ensureMcpConfig, pickMcpConfig } from "../src/claude/mcp-config.ts";
import { codexMcpConfigArgs } from "../src/codex/config.ts";
import { ConfigSchema } from "../src/config/config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-mcp-servers-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "Bearer svk_test_not_a_real_key";

function config(mcpServers: Record<string, unknown>) {
  const c = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
    mcp_servers: mcpServers,
  });
  c.paths.data_dir = dir;
  return c;
}

const skycam = {
  type: "http",
  url: "https://api.example.com/v1/mcp",
  headers: { Authorization: TOKEN },
};

function servers(path: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(path, "utf8")).mcpServers;
}

describe("configured MCP servers", () => {
  test("operator loadouts get the server; contacts do not by default; guests never", () => {
    const paths = ensureMcpConfig(config({ skycam }));
    for (const p of [paths.default, paths.withBrowser, paths.trading]) {
      expect(servers(p).skycam).toEqual(skycam);
    }
    for (const p of [paths.contact, paths.contactWithBrowser, paths.guest]) {
      expect(servers(p).skycam).toBeUndefined();
    }
    // The harness's own server stays in every loadout.
    expect(servers(paths.contact)["edmund-harness"]).toBeDefined();
  });

  test('tiers = ["operator", "contact"] reaches contacts too, still never guests', () => {
    const paths = ensureMcpConfig(
      config({ skycam: { ...skycam, tiers: ["operator", "contact"] } }),
    );
    expect(servers(paths.contact).skycam).toBeDefined();
    expect(servers(paths.contactWithBrowser).skycam).toBeDefined();
    expect(servers(paths.guest).skycam).toBeUndefined();
  });

  test("a stdio server is written as a command", () => {
    const paths = ensureMcpConfig(
      config({
        local: { type: "stdio", command: "/usr/bin/true", args: ["--x"], env: { A: "1" } },
      }),
    );
    expect(servers(paths.default).local).toEqual({
      command: "/usr/bin/true",
      args: ["--x"],
      env: { A: "1" },
    });
  });

  test("a server may not take a name the harness builds itself", () => {
    const paths = ensureMcpConfig(
      config({ "edmund-harness": { type: "http", url: "https://evil.example.com/mcp" } }),
    );
    expect(servers(paths.default)["edmund-harness"]).not.toHaveProperty("url");
  });

  test("every generated file is readable by this user only, even one that existed before", () => {
    writeFileSync(join(dir, "mcp.json"), "{}", { mode: 0o644 });
    ensureMcpConfig(config({ skycam }));
    const files = readdirSync(dir).filter((f) => f.startsWith("mcp") && f.endsWith(".json"));
    expect(files.length).toBe(6);
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  test("Codex gets the same server, with its headers", () => {
    const paths = ensureMcpConfig(config({ skycam }));
    const args = codexMcpConfigArgs(paths.default).join(" ");
    expect(args).toContain('"url" = "https://api.example.com/v1/mcp"');
    expect(args).toContain(TOKEN);
  });
});

describe("the config schema", () => {
  const parse = (mcp_servers: unknown) =>
    ConfigSchema.safeParse({ self: { handles: [] }, allowlist: {}, identity: {}, mcp_servers });

  test("rejects a server that cannot be reached, and a name with odd characters", () => {
    expect(parse({ a: { type: "http" } }).success).toBe(false);
    expect(parse({ a: { type: "stdio" } }).success).toBe(false);
    expect(parse({ "a b": { type: "http", url: "https://example.com" } }).success).toBe(false);
    expect(parse({ a: { type: "http", url: "https://example.com" } }).success).toBe(true);
  });

  test("absent means none, and a server defaults to the operator only", () => {
    expect(
      ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} }).mcp_servers,
    ).toEqual({});
    const parsed = parse({ a: { url: "https://example.com" } });
    expect(parsed.success && parsed.data.mcp_servers.a).toMatchObject({
      type: "http",
      tiers: ["operator"],
    });
  });
});

describe("choosing a loadout", () => {
  const paths: McpConfigPaths = {
    default: "op",
    withBrowser: "op+browser",
    contact: "contact",
    contactWithBrowser: "contact+browser",
    trading: "trading",
    guest: "guest",
  };

  test("trading first, then the session's tier, then the browser", () => {
    expect(pickMcpConfig(paths, { trading: true, tier: "contact", browser: true })).toBe("trading");
    expect(pickMcpConfig(paths, { trading: false, tier: "operator", browser: false })).toBe("op");
    expect(pickMcpConfig(paths, { trading: false, tier: "operator", browser: true })).toBe(
      "op+browser",
    );
    expect(pickMcpConfig(paths, { trading: false, tier: "contact", browser: false })).toBe(
      "contact",
    );
    expect(pickMcpConfig(paths, { trading: false, tier: "contact", browser: true })).toBe(
      "contact+browser",
    );
  });

  test("both runners choose through it", () => {
    for (const f of ["../src/claude/runner.ts", "../src/codex/runner.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      expect(src).toContain("pickMcpConfig(");
      expect(src).toContain("tierForSessionKey(config, input.sessionKey)");
    }
  });
});
