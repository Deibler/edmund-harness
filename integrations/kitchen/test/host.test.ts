/**
 * The kitchen host keeps every household's site at one permanent address.
 *
 * The unit tests pin routing and publishing. The last test runs the real host
 * script against a scratch registry: real share servers, real HTTP, no tunnel.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-host-"));
process.env.KITCHEN_DIR = BASE;

const { getAccount, updateAccount } = await import("../src/accounts.ts");
const { PORTS, freePort, hosted, publish, route, siteStatus, writeStatus } = await import(
  "../src/host.ts"
);

const site = (name: string) => {
  const dir = join(BASE, `site-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><body>${name}'s kitchen</body></html>`);
  return dir;
};

const registry = (tenants: Record<string, unknown>) =>
  writeFileSync(join(BASE, "tenants.json"), JSON.stringify({ version: 1, tenants }));

const household = (siteFields: Record<string, unknown> = {}) => ({
  name: "test",
  created: "2026-01-01T00:00:00+00:00",
  members: ["imessage:dm:+15550000001"],
  site: siteFields,
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

test("a request goes to the household whose key it carries, and nowhere else", () => {
  const hs = [
    { id: "a", artifact: "/a", key: "ka", port: 4801 },
    { id: "b", artifact: "/b", key: "kb", port: 4802 },
  ];
  expect(route(new URL("https://k.example.com/?key=kb"), hs)?.id).toBe("b");
  expect(route(new URL("https://k.example.com/recipe/x.html?key=ka"), hs)?.id).toBe("a");
  expect(route(new URL("https://k.example.com/callback?token=ka"), hs)?.id).toBe("a");
  expect(route(new URL("https://k.example.com/?key=nope"), hs)).toBeNull();
  expect(route(new URL("https://k.example.com/"), hs)).toBeNull();
});

test("publishing keeps a household's key and port, and takes the lowest free port", () => {
  registry({
    a: household({ artifact: site("a"), key: "ka", port: PORTS.first }),
    b: household({ artifact: site("b"), url: "https://old-quick-tunnel.trycloudflare.com/?key=x" }),
    c: household({}),
  });
  expect(freePort()).toBe(PORTS.first + 1);

  const b = publish("b", "https://kitchen.example.com/");
  expect(b.port).toBe(PORTS.first + 1);
  expect(b.url).toBe(`https://kitchen.example.com/?key=${b.key}`);
  expect(b.previous).toBe("https://old-quick-tunnel.trycloudflare.com/?key=x");
  expect(b.key.length).toBeGreaterThanOrEqual(32);
  const again = publish("b", "https://kitchen.example.com");
  expect(again).toMatchObject({ key: b.key, port: b.port, previous: null });
  expect(
    JSON.parse(readFileSync(join(getAccount("b")!.site!.artifact!, "artifact.json"), "utf8")),
  ).toMatchObject({ artifact_id: "kitchen-b" });

  expect(
    hosted()
      .map((h) => h.id)
      .sort(),
  ).toEqual(["a", "b"]);
  expect(() => publish("c", "https://kitchen.example.com")).toThrow("no rendered site");
});

test("a site is live only on a fresh check through the host, never from the registry alone", () => {
  registry({
    a: household({ artifact: site("a"), key: "ka", port: 4801, url: "https://k/?key=ka" }),
  });
  const acct = { ...getAccount("a")!, id: "a" };
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  const status = (
    lastOk: string | null,
    updated = at(0),
    lastError: null | { at: string; why: string } = null,
  ) => ({
    updatedAt: updated,
    origin: "https://k",
    tunnel: { pid: 1, restarts: 0 },
    households: { a: { port: 4801, pid: 2, lastOk, lastError } },
  });

  expect(siteStatus(acct, now, status(at(1))).state).toBe("live");
  expect(siteStatus(acct, now, null)).toMatchObject({
    state: "down",
    why: "the kitchen host is not running",
  });
  expect(siteStatus(acct, now, status(at(1), at(20))).state).toBe("down");
  expect(siteStatus(acct, now, status(at(20))).state).toBe("down");
  expect(siteStatus(acct, now, status(at(3), at(0), { at: at(1), why: "HTTP 530" }))).toMatchObject(
    {
      state: "down",
      why: "HTTP 530",
    },
  );
  updateAccount("a", { site: { key: null } } as never);
  expect(siteStatus({ ...getAccount("a")!, id: "a" }, now, status(at(1))).state).toBe("unhosted");
});

test("the host serves each household by key, keeps callbacks, and restarts a dead server", async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const hp = port + 1;
  const dir = site("live");
  registry({ live: household({ artifact: dir, key: "live-key-0123456789", port: hp }) });
  const data = mkdtempSync(join(tmpdir(), "kitchen-host-data-"));
  // A server left over from a host that was killed outright holds the port.
  const stale = Bun.spawn(
    [
      "python3",
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "skills",
        "instant-share",
        "scripts",
        "secure_server.py",
      ),
      dir,
      String(hp),
      "0",
    ],
    {
      env: { ...process.env, INSTANT_SHARE_TOKEN: "stale-key", INSTANT_SHARE_CONFIG_DIR: data },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  for (
    let i = 0;
    i < 40 && !(await fetch(`http://127.0.0.1:${hp}/?key=stale-key`).catch(() => null));
    i++
  )
    await Bun.sleep(100);
  const host = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "host.ts")], {
    env: {
      ...process.env,
      KITCHEN_DIR: BASE,
      EDMUND_DATA_DIR: data,
      KITCHEN_HOST_PORT: String(port),
      KITCHEN_SITE_ORIGIN: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const get = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, init).catch(() => null);
  const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ok()) return true;
      await Bun.sleep(250);
    }
    return false;
  };
  try {
    expect(await until(async () => (await get("/?key=live-key-0123456789"))?.status === 200)).toBe(
      true,
    );
    expect(await (await get("/?key=live-key-0123456789"))!.text()).toContain("live's kitchen");
    expect(await stale.exited).not.toBe(0);
    expect((await get("/?key=someone-else"))!.status).toBe(404);

    const posted = await get("/callback?key=live-key-0123456789", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "make", recipe: "soup" }),
    });
    expect(posted!.status).toBe(200);
    expect(readFileSync(join(dir, "_callbacks.jsonl"), "utf8")).toContain('"recipe": "soup"');

    // The status file is what "is the site live" reads.
    expect(
      await until(async () =>
        Boolean(JSON.parse(readFileSync(join(BASE, "host.json"), "utf8")).households.live?.lastOk),
      ),
    ).toBe(true);

    // Kill the household's server: the host brings it back on the same port.
    const pid = JSON.parse(readFileSync(join(BASE, "host.json"), "utf8")).households.live.pid;
    process.kill(pid, "SIGKILL");
    expect(
      await until(async () => (await get("/?key=live-key-0123456789"))?.status === 200, 30_000),
    ).toBe(true);
  } finally {
    stale.kill();
    host.kill();
    await host.exited;
    rmSync(data, { recursive: true, force: true });
  }
}, 90_000);

test("writeStatus replaces the file whole", () => {
  writeStatus({ updatedAt: "x", origin: null, tunnel: { pid: null, restarts: 0 }, households: {} });
  expect(JSON.parse(readFileSync(join(BASE, "host.json"), "utf8")).updatedAt).toBe("x");
});

test("the doctor calls a hosted site broken when the host cannot reach it, and a temporary link a temporary link", async () => {
  const { checkAccount } = await import("../src/doctor.ts");
  registry({
    h: household({ artifact: site("h"), key: "kh", port: 4801, url: "https://k/?key=kh" }),
    q: household({ artifact: site("q"), url: "https://gone.trycloudflare.com/?key=x" }),
  });
  const siteOf = (id: string) => checkAccount(id).findings.find((f) => f.what === "site")!;
  const now = new Date().toISOString();
  const write = (lastOk: string | null) =>
    writeStatus({
      updatedAt: now,
      origin: "https://k",
      tunnel: { pid: 1, restarts: 0 },
      households: {
        h: { port: 4801, pid: 2, lastOk, lastError: lastOk ? null : { at: now, why: "HTTP 530" } },
      },
    });
  write(null);
  expect(siteOf("h")).toMatchObject({ level: "broken" });
  expect(siteOf("h").detail).toContain("HTTP 530");
  write(now);
  expect(siteOf("h").level).toBe("ok");
  expect(siteOf("q")).toMatchObject({ level: "absent" });
  expect(siteOf("q").fix).toContain("host:true");
});
