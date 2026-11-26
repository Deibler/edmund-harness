/**
 * Who is knocking: an outside address is scored for what it does, blocked
 * quietly when it scores high, and reviewed only for harm or persistence;
 * and the files that persist are watched for change.
 *
 * Every address here is from the ranges reserved for documentation
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { summarizeTraffic } from "../cli/commands/log-traffic.ts";
import { BLOCK_SCORE, type Hit, Inbound, subnetOf } from "../src/security/watch/inbound.ts";
import {
  Reputation,
  type Standing,
  ipv4ToInt,
  parseAsnTable,
  parseNetset,
  refreshReputation,
} from "../src/security/watch/reputation.ts";
import { withAccessLog } from "../src/util/access-log.ts";
import {
  block,
  blockedReason,
  currentBlocks,
  unblock,
  useBlocklist,
} from "../src/util/blocklist.ts";
import { ChangeWatch, configShape } from "../src/watch/changes.ts";
import { InboundWatch, hitOf, isSelf } from "../src/watch/inbound-watch.ts";
import type { Incident } from "../src/watch/incidents.ts";
import type { Verdict } from "../src/watch/judge.ts";

const NOBODY: Standing = { listed: [], asn: null, org: "", network: "unknown" };
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "watch-inbound-"));
});
afterEach(() => {
  useBlocklist(null);
  rmSync(root, { recursive: true, force: true });
});

function hit(ip: string, path: string, status: number, over: Partial<Hit> = {}): Hit {
  return {
    at: T0,
    ip,
    server: "public-router",
    method: "GET",
    path,
    status,
    probes: [],
    client: "browser",
    ...over,
  };
}

describe("reputation, from lists kept on this machine", () => {
  test("a list is addresses and blocks, with comments, and never the private ranges", () => {
    const ranges = parseNetset(
      "; Spamhaus DROP\n203.0.113.0/24 ; SBL1\n198.51.100.7\n# firehol also lists\n10.0.0.0/8\n192.168.0.0/16\nnot an address\n",
    );
    expect([...ranges.starts]).toEqual([ipv4ToInt("198.51.100.7")!, ipv4ToInt("203.0.113.0")!]);
    expect(ipv4ToInt("256.1.1.1")).toBeNull();
    expect(ipv4ToInt("2001:db8::1")).toBeNull();
  });

  test("an address is looked up in every list, and its network is told from its owner's name", () => {
    const dir = join(root, "reputation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spamhaus-drop.txt"), "203.0.113.0/24 ; SBL1\n");
    writeFileSync(join(dir, "tor-exits.txt"), "198.51.100.9\n");
    writeFileSync(
      join(dir, "ip2asn-v4.tsv.gz"),
      gzipSync(
        [
          "192.0.2.0\t192.0.2.255\t64500\tUS\tEXAMPLE-CLOUD Hosting LLC",
          "198.51.100.0\t198.51.100.255\t64501\tUS\tEXAMPLE-CABLE Communications",
          "203.0.113.0\t203.0.113.255\t0\tNone\tNot routed",
        ].join("\n"),
      ),
    );
    const reputation = new Reputation(dir);
    expect(reputation.loaded).toMatchObject({ "spamhaus-drop": 1, "tor-exit": 1, asn: 2 });
    expect(reputation.lookup("192.0.2.44")).toEqual({
      listed: [],
      asn: 64500,
      org: "EXAMPLE-CLOUD Hosting LLC",
      network: "hosting",
    });
    expect(reputation.lookup("198.51.100.20").network).toBe("provider");
    expect(reputation.lookup("198.51.100.9")).toMatchObject({
      listed: ["tor-exit"],
      network: "tor",
    });
    expect(reputation.lookup("203.0.113.5").listed).toEqual(["spamhaus-drop"]);
    // A list that is on disk and does not read is said, not skipped in silence.
    writeFileSync(join(dir, "ip2asn-v4.tsv.gz"), "this is not gzip");
    const broken = new Reputation(dir);
    expect(broken.unreadable.map((u) => u.name)).toEqual(["asn"]);
    expect(broken.lookup("192.0.2.44").network).toBe("unknown");
    // Never an outside visitor, whatever a list says.
    expect(reputation.lookup("192.168.1.10")).toEqual(NOBODY);
    expect(reputation.lookup("2001:db8::1")).toEqual(NOBODY);
    expect(parseAsnTable("1.2.3.0\t1.2.3.255\t0\tNone\tNot routed").starts.length).toBe(0);
  });

  test("a list is fetched when it is missing or a day old, and what failed is said", async () => {
    const dir = join(root, "reputation");
    mkdirSync(dir, { recursive: true });
    const asked: string[] = [];
    // The address table is 8.7 MB. The shared file writer refuses anything
    // over 1 MB, and the first live run lost the table to that in silence.
    const table = gzipSync(
      Buffer.alloc(3 * 1024 * 1024, "192.0.2.0\t192.0.2.255\t64500\tUS\tEXAMPLE\n"),
      { level: 0 },
    );
    expect(table.length).toBeGreaterThan(2 * 1024 * 1024);
    const fetcher = (async (url: string) => {
      asked.push(url);
      if (url.includes("torproject")) return new Response("nope", { status: 200 });
      if (url.includes("firehol")) return new Response("gone", { status: 404 });
      if (url.includes("iptoasn")) return new Response(table);
      return new Response(`${"203.0.113.0/24\n".repeat(20)}`);
    }) as unknown as typeof fetch;
    const first = await refreshReputation(dir, fetcher, T0);
    expect(first.replaced.sort()).toEqual(["asn", "spamhaus-drop"]);
    expect(first.failed).toEqual([
      { name: "firehol-level1", why: "answered 404" },
      { name: "tor-exit", why: "only 4 bytes came back" },
    ]);
    expect(asked).toHaveLength(4);
    expect(new Reputation(dir).loaded.asn).toBeGreaterThan(0);
    // An hour later only what failed is asked for again.
    asked.length = 0;
    await refreshReputation(dir, fetcher, Date.now() + 3_600_000);
    expect(asked.some((u) => u.includes("spamhaus") || u.includes("iptoasn"))).toBe(false);
    expect(asked.some((u) => u.includes("torproject"))).toBe(true);
  });
});

describe("an outside address, scored for what it does", () => {
  test("an ordinary visitor scores nothing and is never reviewed", () => {
    const inbound = new Inbound(() => NOBODY);
    for (const path of ["/", "/app.js", "/style.css", "/recipes", "/recipes/1"]) {
      expect(inbound.observe(hit("198.51.100.20", path, 200))).toEqual({
        reviews: [],
        block: null,
      });
    }
    expect(inbound.scoreOf("198.51.100.20", T0)).toBe(0);
  });

  test("a scanner is blocked quietly once, and nobody is asked to review background noise", () => {
    const inbound = new Inbound(() => ({ ...NOBODY, network: "hosting", org: "EXAMPLE-CLOUD" }));
    const outcomes = [
      "/.env",
      "/wp-login.php",
      "/.git/config",
      "/phpmyadmin/",
      "/actuator/env",
    ].map((path, i) =>
      inbound.observe(
        hit("192.0.2.44", path, 404, {
          at: T0 + i * 1000,
          probes: [["probe:secrets", "probe:cms", "probe:secrets", "probe:cms", "probe:admin"][i]!],
          client: "scanner:zgrab",
        }),
      ),
    );
    expect(outcomes.flatMap((o) => o.reviews)).toEqual([]);
    const blocks = outcomes.filter((o) => o.block);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.block!.target).toBe("192.0.2.44");
    expect(inbound.scoreOf("192.0.2.44", T0 + 5000)).toBeGreaterThanOrEqual(BLOCK_SCORE);
  });

  test("a score fades: half is gone in six hours, nearly all in a day", () => {
    const inbound = new Inbound(() => NOBODY);
    inbound.observe(hit("192.0.2.44", "/.env", 404, { probes: ["probe:secrets"] }));
    const now = inbound.scoreOf("192.0.2.44", T0);
    expect(inbound.scoreOf("192.0.2.44", T0 + 6 * 3_600_000)).toBeCloseTo(now / 2, 5);
    expect(inbound.scoreOf("192.0.2.44", T0 + 24 * 3_600_000)).toBeLessThan(now / 10);
  });

  test("a bad reputation alone adds to the score and trips nothing", () => {
    const inbound = new Inbound(() => ({ ...NOBODY, listed: ["spamhaus-drop"] }));
    const outcome = inbound.observe(hit("203.0.113.5", "/", 200));
    expect(outcome).toEqual({ reviews: [], block: null });
    expect(inbound.scoreOf("203.0.113.5", T0)).toBe(25);
  });

  test("something that got through is reviewed: a probe answered with a page", () => {
    const inbound = new Inbound(() => NOBODY);
    const refused = inbound.observe(hit("192.0.2.44", "/.env", 404, { probes: ["probe:secrets"] }));
    expect(refused.reviews).toEqual([]);
    const served = inbound.observe(
      hit("192.0.2.44", "/backup.sql", 200, { probes: ["probe:secrets"] }),
    );
    expect(served.reviews.map((r) => r.reason)).toEqual(["got-through"]);
    expect(served.reviews[0]!.why).toContain("answered 200 at /backup.sql");
    expect(served.reviews[0]!.record).toContain("GET /backup.sql -> 200 [probe:secrets]");
    // The same thing again is not a second review.
    expect(
      inbound.observe(hit("192.0.2.44", "/backup.sql", 200, { probes: ["probe:secrets"] })).reviews,
    ).toEqual([]);
  });

  test("refused keys and then an accepted one is a key guessed; a first visit with a good key is not", () => {
    const inbound = new Inbound(() => NOBODY);
    expect(inbound.observe(hit("198.51.100.20", "/share/", 200)).reviews).toEqual([]);
    for (let i = 0; i < 3; i++) inbound.observe(hit("192.0.2.44", "/share/", 403, { at: T0 + i }));
    const through = inbound.observe(hit("192.0.2.44", "/share/", 200, { at: T0 + 10 }));
    expect(through.reviews.map((r) => r.reason)).toEqual(["key-guessed"]);
  });

  test("refusals that keep coming are brute force", () => {
    const inbound = new Inbound(() => NOBODY);
    const reasons: string[] = [];
    for (let i = 0; i < 9; i++) {
      reasons.push(
        ...inbound
          .observe(hit("192.0.2.44", "/share/", 403, { at: T0 + i * 1000 }))
          .reviews.map((r) => r.reason),
      );
    }
    expect(reasons).toEqual(["brute-force"]);
  });

  test("a payload aimed at a page that exists here is reviewed; the same at a page that does not is noise", () => {
    const inbound = new Inbound(() => NOBODY);
    inbound.observe(hit("198.51.100.20", "/recipes", 200));
    const noise = inbound.observe(hit("192.0.2.44", "/nothing", 404, { probes: ["injection"] }));
    expect(noise.reviews).toEqual([]);
    const aimed = inbound.observe(hit("192.0.2.44", "/recipes", 400, { probes: ["injection"] }));
    expect(aimed.reviews.map((r) => r.reason)).toEqual(["aimed"]);
  });

  test("coming back hour after hour, walking many paths, or returning after a block is persistence", () => {
    const hours = new Inbound(() => NOBODY);
    const seen: string[] = [];
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 4; i++) {
        const o = hours.observe(
          hit("192.0.2.44", `/p${h}${i}.php`, 404, {
            at: T0 + h * 3_600_000 + i * 1000,
            probes: ["probe:exploit"],
          }),
        );
        seen.push(...o.reviews.map((r) => r.why));
      }
    }
    expect(seen).toEqual(["it has come back in 3 separate hours and keeps probing"]);

    const walker = new Inbound(() => NOBODY);
    const walked: string[] = [];
    for (let i = 0; i < 45; i++) {
      walked.push(
        ...walker
          .observe(hit("192.0.2.45", `/guess-${i}`, 404, { at: T0 + i }))
          .reviews.map((r) => r.reason),
      );
    }
    expect(walked).toEqual(["persistent"]);

    const back = new Inbound(() => NOBODY);
    expect(back.observe(hit("192.0.2.46", "/", 403, { blocked: true })).reviews[0]!.why).toBe(
      "it was blocked and is still trying",
    );
  });

  test("many addresses in one subnet, each under any limit, are a flood together", () => {
    const inbound = new Inbound(() => NOBODY);
    const floods: string[] = [];
    for (let i = 0; i < 320; i++) {
      const o = inbound.observe(hit(`203.0.113.${i % 40}`, "/", 200, { at: T0 + i * 100 }));
      floods.push(...o.reviews.filter((r) => r.reason === "flood").map((r) => r.subject));
    }
    expect(floods).toEqual(["203.0.113.0/24"]);
    expect(subnetOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
  });

  test("a link that has got out: many new addresses on one path at once", () => {
    const inbound = new Inbound(() => NOBODY);
    const leaks: string[] = [];
    for (let i = 0; i < 25; i++) {
      const o = inbound.observe(hit(`198.51.${i}.9`, "/shelf/abc123/", 200, { at: T0 + i * 500 }));
      leaks.push(...o.reviews.filter((r) => r.reason === "leaked-link").map((r) => r.subject));
    }
    expect(leaks).toEqual(["public-router /shelf/abc123/"]);
  });
});

describe("the blocklist every server reads", () => {
  test("an address or its subnet is refused until the block ends, and nobody is blocked until a list is named", () => {
    const file = join(root, "blocked.json");
    expect(blockedReason("192.0.2.44", T0)).toBeNull();
    block("192.0.2.44", "ignored: no list yet", T0 + 1000, T0);
    useBlocklist(file);
    block("192.0.2.44", "probing", T0 + 60_000, T0);
    block("203.0.113.0/24", "a flood", T0 + 60_000, T0);
    expect(blockedReason("192.0.2.44", T0 + 1)).toBe("probing");
    expect(blockedReason("203.0.113.77", T0 + 1)).toBe("a flood");
    expect(blockedReason("192.0.2.45", T0 + 1)).toBeNull();
    expect(blockedReason("192.0.2.44", T0 + 120_000)).toBeNull();
    expect(Object.keys(currentBlocks(T0 + 1)).sort()).toEqual(["192.0.2.44", "203.0.113.0/24"]);
    expect(unblock("192.0.2.44", T0 + 1)).toBe(true);
    expect(unblock("192.0.2.44", T0 + 1)).toBe(false);
    expect(blockedReason("192.0.2.44", T0 + 1)).toBeNull();
  });

  test("a server refuses a blocked address before its own code runs", async () => {
    useBlocklist(join(root, "blocked.json"));
    let ran = 0;
    const serve = withAccessLog("test", () => {
      ran++;
      return new Response("page");
    });
    const from = (ip: string) =>
      serve(new Request("http://example.com/x", { headers: { "cf-connecting-ip": ip } }), {});
    expect((await from("192.0.2.44")).status).toBe(200);
    block("192.0.2.44", "probing", Date.now() + 60_000);
    const refused = await from("192.0.2.44");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("Forbidden");
    expect((await from("192.0.2.45")).status).toBe(200);
    expect(ran).toBe(2);
  });
});

describe("the log every server writes, read as visitors", () => {
  const self = { v4: ["198.51.100.1"], v6: ["2001:db8:1:2::/64"] };

  test("only an outside caller is a visitor: not this machine, not a relayed copy, not a repeat count", () => {
    const fields = {
      server: "public-router",
      method: "GET",
      path: "/.env",
      status: 404,
      via: "192.0.2.44",
      ua: "curl/8.0",
    };
    expect(hitOf("2026-11-25T12:00:00.000Z", fields, self)).toMatchObject({
      ip: "192.0.2.44",
      probes: ["probe:secrets"],
      client: "tool",
      status: 404,
    });
    expect(
      hitOf("2026-11-25T12:00:00.000Z", { ...fields, via: undefined, ip: "127.0.0.1" }, self),
    ).toBeNull();
    expect(hitOf("2026-11-25T12:00:00.000Z", { ...fields, relayed: true }, self)).toBeNull();
    expect(hitOf("2026-11-25T12:00:00.000Z", { ...fields, count: 12 }, self)).toBeNull();
    expect(hitOf("2026-11-25T12:00:00.000Z", { ...fields, via: "198.51.100.1" }, self)).toBeNull();
    expect(isSelf(self, "2001:db8:1:2:9:9:9:9")).toBe(true);
    expect(isSelf(self, "2001:db8:1:3::1")).toBe(false);
  });

  function watching(mode: "observe" | "enforce", verdict: Verdict | null) {
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "watch"), { recursive: true });
    useBlocklist(join(dataDir, "watch", "blocked.json"));
    const incidents: Incident[] = [];
    const judged: string[] = [];
    const watch = new InboundWatch({
      dataDir,
      logsDir: join(root, "logs"),
      mode,
      judge: async (_record, flagged) => {
        judged.push(flagged);
        return verdict;
      },
      record: async (incident) => {
        incidents.push(incident);
      },
      now: () => T0,
    });
    return { watch, incidents, judged };
  }

  test("a high score is a quiet block: no review, no incident", async () => {
    const { watch, incidents, judged } = watching("enforce", null);
    for (const path of ["/.env", "/wp-login.php", "/.git/config", "/phpmyadmin/"]) {
      await watch.take(
        hit("192.0.2.44", path, 404, {
          probes: ["probe:secrets", "probe:cms"],
          client: "scanner:zgrab",
        }),
      );
    }
    expect(blockedReason("192.0.2.44", T0 + 1)).toContain("score");
    expect(incidents).toEqual([]);
    expect(judged).toEqual([]);
    expect(watch.counts.blocked).toBe(1);
  });

  test("observe mode blocks nobody", async () => {
    const { watch } = watching("observe", null);
    for (const path of ["/.env", "/wp-login.php", "/.git/config", "/phpmyadmin/"]) {
      await watch.take(
        hit("192.0.2.44", path, 404, {
          probes: ["probe:secrets", "probe:cms"],
          client: "scanner:zgrab",
        }),
      );
    }
    expect(blockedReason("192.0.2.44", T0 + 1)).toBeNull();
    expect(watch.counts.blocked).toBe(1);
  });

  test("the judge sets the tier: serious is blocked and raised, benign is only recorded", async () => {
    const serious = watching("enforce", {
      verdict: "serious",
      why: "a backup file was served to a probe",
    });
    await serious.watch.take(hit("192.0.2.44", "/backup.sql", 200, { probes: ["probe:secrets"] }));
    expect(serious.incidents).toHaveLength(1);
    expect(serious.incidents[0]).toMatchObject({
      kind: "inbound-got-through",
      tier: "serious",
      where: "192.0.2.44",
      did: ["blocked it for a day"],
      undo: [{ kind: "unblock", target: "192.0.2.44" }],
    });
    expect(blockedReason("192.0.2.44", T0 + 1)).not.toBeNull();

    const benign = watching("enforce", { verdict: "benign", why: "a refused probe" });
    await benign.watch.take(hit("192.0.2.50", "/backup.sql", 200, { probes: ["probe:secrets"] }));
    expect(benign.judged).toHaveLength(1);
    expect(benign.incidents).toEqual([]);
    expect(blockedReason("192.0.2.50", T0 + 1)).toBeNull();
  });

  test("brute force is serious on its face, whatever the judge says or does not", async () => {
    const { watch, incidents } = watching("enforce", null);
    for (let i = 0; i < 9; i++)
      await watch.take(hit("192.0.2.44", "/share/", 403, { at: T0 + i * 1000 }));
    expect(incidents.map((i) => `${i.kind}:${i.tier}`)).toEqual(["inbound-brute-force:serious"]);
    expect(incidents[0]!.did).toEqual(["blocked it for a day"]);
  });
});

describe("the traffic report", () => {
  test("counts this machine's own address as its own, not as a visitor from outside", () => {
    const rec = (via: string | undefined, count?: number) => ({
      ts: "2026-11-25T12:00:00.000Z",
      level: "info",
      ch: "net-in",
      tag: "net-in",
      msg: "x",
      proc: "router",
      pid: 1,
      seq: 1,
      fields: { server: "public-router", status: 200, via, ...(count ? { count } : {}) },
    });
    const records = [
      rec("198.51.100.1"),
      rec("198.51.100.1", 9),
      rec("192.0.2.44"),
      rec(undefined),
    ];
    const self = { v4: ["198.51.100.1"], v6: [] };
    const mine = summarizeTraffic(records as never, [], self);
    expect([mine.requests, mine.fromOutside, mine.fromSelf]).toEqual([12, 1, 10]);
    expect(mine.clients.map((c) => c.client)).toEqual(["192.0.2.44"]);
    // Without knowing which address is its own, the operator looked like the busiest stranger.
    const unknown = summarizeTraffic(records as never, []);
    expect([unknown.fromOutside, unknown.fromSelf]).toEqual([11, 0]);
  });
});

describe("the change watch", () => {
  test("config.toml is kept as key names and fingerprints, never values", () => {
    const text = [
      "[alerts]",
      'operator_handle = "+15550100050"',
      "[security]",
      'model_host_access = "sandboxed"',
      "[sms]",
      'webhook_url = "https://example.com/hook"',
      'auth_token = "a-secret-value-that-must-not-be-kept"',
    ].join("\n");
    const shape = configShape(text);
    expect(shape.keys).toEqual([
      "alerts.operator_handle",
      "security.model_host_access",
      "sms.auth_token",
      "sms.webhook_url",
    ]);
    expect(JSON.stringify(shape)).not.toContain("a-secret-value");
    expect(JSON.stringify(shape)).not.toContain("example.com");
    const loosened = configShape(text.replace('"sandboxed"', '"full"'));
    expect(loosened.security).not.toBe(shape.security);
    expect(loosened.webhooks).toBe(shape.webhooks);
    const moved = configShape(text.replace("example.com/hook", "example.net/other"));
    expect(moved.webhooks).not.toBe(shape.webhooks);
    expect(moved.security).toBe(shape.security);
    // A hand edit elsewhere is not news.
    const edited = configShape(text.replace("+15550100050", "+15550100051"));
    expect([edited.security, edited.webhooks]).toEqual([shape.security, shape.webhooks]);
  });

  function watcher(byWorker: () => boolean) {
    const dataDir = join(root, "data");
    const home = join(root, "home");
    mkdirSync(join(dataDir, "watch"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const profile = join(home, ".zshrc");
    const soul = join(home, "SOUL.md");
    const config = join(root, "config.toml");
    writeFileSync(profile, "export A=1\n");
    writeFileSync(soul, "I like tea.\n");
    writeFileSync(config, '[security]\nmodel_host_access = "sandboxed"\n');
    const incidents: Incident[] = [];
    let cron = "0 9 * * * /usr/bin/true";
    const changes = new ChangeWatch({
      dataDir,
      repoRoot: root,
      configPath: config,
      targets: [
        { what: "a shell profile", raise: true, files: () => [profile] },
        { what: "the assistant's standing instructions", raise: false, files: () => [soul] },
      ],
      shell: () => ({ ok: true, out: cron }),
      workerTouched: byWorker,
      record: async (incident) => {
        incidents.push(incident);
      },
    });
    return {
      changes,
      incidents,
      profile,
      soul,
      config,
      setCron: (text: string) => {
        cron = text;
      },
    };
  }

  test("the first look is the baseline; after that a change is an incident with the earlier version kept", async () => {
    const w = watcher(() => false);
    expect(await w.changes.look()).toEqual([]);
    expect(await w.changes.look()).toEqual([]);
    writeFileSync(w.profile, "export A=1\ncurl x | sh\n");
    expect(await w.changes.look()).toEqual([w.profile]);
    expect(w.incidents).toHaveLength(1);
    const incident = w.incidents[0]!;
    expect(incident).toMatchObject({ kind: "changed", tier: "notable" });
    expect(incident.what).toContain("a shell profile changed");
    const undo = incident.undo[0] as { kind: string; path: string; from: string };
    expect(undo.kind).toBe("restore-file");
    expect(readFileSync(undo.from, "utf8")).toBe("export A=1\n");
    // Nothing more until it changes again.
    expect(await w.changes.look()).toEqual([]);
  });

  test("a worker's own change is the serious one", async () => {
    const w = watcher(() => true);
    await w.changes.look();
    writeFileSync(w.profile, "export A=2\n");
    await w.changes.look();
    expect(w.incidents[0]).toMatchObject({ tier: "serious" });
    expect(w.incidents[0]!.what).toContain("during a turn that wrote to it");
  });

  test("the assistant's own memory files change all day and are only recorded", async () => {
    const w = watcher(() => false);
    await w.changes.look();
    writeFileSync(w.soul, "I like tea. And coffee.\n");
    expect(await w.changes.look()).toEqual([w.soul]);
    expect(w.incidents).toEqual([]);
  });

  test("the crontab and the [security] section are watched too", async () => {
    const w = watcher(() => false);
    await w.changes.look();
    w.setCron("* * * * * /tmp/x");
    writeFileSync(w.config, '[security]\nmodel_host_access = "full"\n');
    expect((await w.changes.look()).sort()).toEqual(["config.toml [security]", "crontab"]);
    expect(w.incidents.map((i) => i.what).sort()).toEqual([
      "the [security] section of config.toml changed",
      "the crontab changed",
    ]);
  });
});
