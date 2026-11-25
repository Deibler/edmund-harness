/**
 * The record of what a server was asked: every request on its own, except a
 * successful GET the same caller repeats within a minute, which is counted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAccessLog } from "../src/util/access-log.ts";
import { readChannel } from "../src/util/log-files.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";

let dir = "";
const realNow = Date.now;
let now = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "access-log-"));
  installLogSink(dir, "", "daemon.log", { echo: false, instrument: false });
  now = realNow();
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
  uninstallLogSink();
  rmSync(dir, { recursive: true, force: true });
});

const caller = (ip: string) => ({ requestIP: () => ({ address: ip }) });
const req = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });

describe("requests a server answered", () => {
  test("a poll repeated by one caller is one record and a count; another caller is its own", async () => {
    const name = `dash-${Math.random().toString(36).slice(2)}`;
    const handler = withAccessLog(name, () => new Response("ok"));
    for (let i = 0; i < 30; i++) await handler(req("/api/pool"), caller("192.0.2.10"));
    await handler(req("/api/pool"), caller("192.0.2.99"));
    let records = readChannel(dir, "net-in", 0).filter((r) => r.fields!.server === name);
    expect(records.map((r) => r.fields!.ip)).toEqual(["192.0.2.10", "192.0.2.99"]);

    // A minute on, the next poll writes the count of the ones in between, then itself.
    now += 61_000;
    await handler(req("/api/pool"), caller("192.0.2.10"));
    records = readChannel(dir, "net-in", 0).filter((r) => r.fields!.server === name);
    expect(records).toHaveLength(4);
    expect(records[2]!.msg).toBe(`${name} GET /api/pool 200 repeated 29 more`);
    expect(records[2]!.fields).toMatchObject({ count: 29, ip: "192.0.2.10" });
    expect(records[3]!.msg).toBe(`${name} GET /api/pool 200`);
  });

  test("a change, a refusal and a failure are each their own record every time", async () => {
    const name = `dash-${Math.random().toString(36).slice(2)}`;
    const handler = withAccessLog(name, (r: Request) => {
      const path = new URL(r.url).pathname;
      if (path === "/api/secret") return new Response("no", { status: 401 });
      if (path === "/api/broken") throw new Error("handler fell over");
      return new Response("ok");
    });
    for (let i = 0; i < 3; i++) await handler(req("/api/config", "PUT"), caller("192.0.2.10"));
    for (let i = 0; i < 3; i++) await handler(req("/api/secret"), caller("192.0.2.10"));
    await expect(handler(req("/api/broken"), caller("192.0.2.10"))).rejects.toThrow("fell over");
    const mine = (channel: "net-in" | "security") =>
      readChannel(dir, channel, 0).filter((r) => r.fields!.server === name);
    expect(mine("net-in").map((r) => r.fields!.status)).toEqual([
      200, 200, 200, 401, 401, 401, 500,
    ]);
    expect(mine("net-in").at(-1)!.fields!.err).toBe("handler fell over");
    expect(mine("security")).toHaveLength(3);
  });

  test("a connection that became a WebSocket is recorded as one", async () => {
    const name = `ws-${Math.random().toString(36).slice(2)}`;
    const handler = withAccessLog(name, () => undefined);
    expect(await handler(req("/ws"), caller("192.0.2.10"))).toBeUndefined();
    expect(
      readChannel(dir, "net-in", 0).find((r) => r.fields!.server === name)!.fields!.status,
    ).toBe(101);
  });
});
