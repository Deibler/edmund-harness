/**
 * What on the machine can be reached from outside it, and the report that
 * sums who has been at the door.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeTraffic } from "../cli/commands/log-traffic.ts";
import {
  ExposureWatch,
  type Listener,
  type Tunnel,
  parseListeners,
  parseTunnels,
} from "../src/boot/exposure.ts";
import { withAccessLog } from "../src/util/access-log.ts";
import { readChannel } from "../src/util/log-files.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";

describe("reading what the system reports", () => {
  test("listeners another machine can reach; loopback ones are not among them", () => {
    const out = [
      "p689",
      "cControlCenter",
      "f9",
      "n*:7000",
      "f10",
      "n*:7000",
      "f11",
      "n*:5000",
      "p1392",
      "cPython",
      "f3",
      "n127.0.0.1:8096",
      "p4000",
      "cbun",
      "f5",
      "n192.0.2.20:4747",
      "f6",
      "n[::1]:9000",
    ].join("\n");
    expect(parseListeners(out)).toEqual([
      { command: "bun", pid: 4000, address: "192.0.2.20", port: 4747 },
      { command: "ControlCenter", pid: 689, address: "*", port: 5000 },
      { command: "ControlCenter", pid: 689, address: "*", port: 7000 },
    ]);
  });

  test("tunnels and what they publish, never the token", () => {
    const out = [
      " 1409 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run --token-file /Users/x/app/data/secrets/sms-tunnel-token",
      "33398 cloudflared tunnel --no-autoupdate --url http://127.0.0.1:62294",
      "  501 /opt/homebrew/bin/bun src/main.ts",
      " 7000 cloudflared tunnel run --token eyJhIjoic2VjcmV0In0",
    ].join("\n");
    const tunnels = parseTunnels(out);
    expect(tunnels).toEqual([
      { pid: 1409, kind: "named", target: "sms-tunnel-token" },
      { pid: 33398, kind: "quick", target: "http://127.0.0.1:62294" },
      { pid: 7000, kind: "named", target: "named tunnel" },
    ]);
    expect(JSON.stringify(tunnels)).not.toContain("eyJ");
  });
});

describe("the record", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exposure-"));
    installLogSink(dir, "", "daemon.log", { echo: false, instrument: false });
  });
  afterEach(() => {
    uninstallLogSink();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the first reading whole, then what opened as a warning and what closed", async () => {
    let listeners: Listener[] = [{ command: "bun", pid: 1, address: "*", port: 4747 }];
    let tunnels: Tunnel[] = [{ pid: 2, kind: "named", target: "sms-tunnel-token" }];
    const watch = new ExposureWatch({
      intervalMs: 300_000,
      readListeners: async () => listeners,
      readTunnels: async () => tunnels,
    });
    await watch.sample();
    await watch.sample();
    tunnels = [...tunnels, { pid: 3, kind: "quick", target: "http://127.0.0.1:62294" }];
    listeners = [];
    await watch.sample();
    const records = readChannel(dir, "security", 0).filter((r) => r.tag === "exposure");
    expect(records.map((r) => [r.level, r.msg])).toEqual([
      ["info", "reachable from outside: 1 tunnels, 1 network listeners"],
      ["warn", "tunnel opened: quick to http://127.0.0.1:62294"],
      ["info", "network listener closed: bun on port 4747"],
    ]);
  });

  test("the report sums the door: who, from where, what they tried, and what is open", async () => {
    const server = "router";
    const handler = withAccessLog(server, (r: Request) =>
      new URL(r.url).pathname.startsWith("/kitchen")
        ? new Response("ok")
        : new Response("no", { status: 404 }),
    );
    const ask = (ip: string, path: string, ua: string, country: string) =>
      handler(
        new Request(`http://site.example.com${path}`, {
          headers: {
            "cf-connecting-ip": ip,
            "cf-ipcountry": country,
            "user-agent": ua,
            host: "site.example.com",
          },
        }),
        { requestIP: () => ({ address: "127.0.0.1" }) },
      );
    const browser = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
    for (let i = 0; i < 5; i++) await ask("198.51.100.7", `/kitchen/page-${i}`, browser, "US");
    for (const path of [
      "/.env",
      "/.git/config",
      "/wp-login.php",
      "/phpmyadmin/",
      "/actuator/env",
      "/.aws/credentials",
    ]) {
      await ask("203.0.113.50", path, "Mozilla/5.0 zgrab/0.x", "NL");
    }
    await handler(new Request("http://127.0.0.1/kitchen/local"), {
      requestIP: () => ({ address: "127.0.0.1" }),
    });
    const watch = new ExposureWatch({
      intervalMs: 300_000,
      readListeners: async () => [{ command: "bun", pid: 1, address: "*", port: 4747 }],
      readTunnels: async () => [{ pid: 2, kind: "quick", target: "http://127.0.0.1:4749" }],
    });
    await watch.sample();

    const s = summarizeTraffic(readChannel(dir, "net-in", 0), readChannel(dir, "security", 0));
    expect(s.requests).toBe(12);
    expect(s.fromOutside).toBe(11);
    expect(s.byHost).toEqual([["site.example.com", 11]]);
    expect(Object.fromEntries(s.byClientKind)).toEqual({ scanner: 6, browser: 5 });
    expect(Object.fromEntries(s.byCountry)).toEqual({ NL: 6, US: 5 });
    expect(s.newClients).toBe(2);
    // The scanner is first, with what it tried.
    expect(s.clients[0]).toMatchObject({
      client: "203.0.113.50",
      probes: 6,
      refused: 6,
      kind: "scanner",
      country: "NL",
    });
    expect(s.clients[1]).toMatchObject({ client: "198.51.100.7", probes: 0, refused: 0 });
    expect(s.events.map((e) => e.kind)).toEqual(["scan"]);
    expect(Object.fromEntries(s.probes)["probe:secrets"]).toBe(3);
    expect(s.exposure).toEqual({
      tunnels: ["quick to http://127.0.0.1:4749"],
      listeners: ["bun on port 4747"],
      changes: [],
    });
  });

  test("an hour several times busier than the others stands out", () => {
    const record = (hour: string, n: number) => ({
      ts: `2026-11-25T${hour}:10:00.000Z`,
      level: "info" as const,
      ch: "net-in" as const,
      tag: "net-in",
      msg: "x",
      proc: "public-router",
      pid: 1,
      fields: { server: "router", status: 200, via: "198.51.100.7", count: n },
    });
    const s = summarizeTraffic(
      [record("09", 20), record("10", 25), record("11", 30), record("12", 900)],
      [],
    );
    expect(s.outlierHours).toEqual([{ hour: "2026-11-25T12:00Z", requests: 900, typical: 30 }]);
  });
});
