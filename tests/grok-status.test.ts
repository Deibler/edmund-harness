import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExchangeLog } from "../src/grok/exchanges.ts";
import {
  agoPhrase,
  checkEdmund,
  printerLineFrom,
  printingLine,
  speakable,
} from "../src/grok/status.ts";

const dirs: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "grok-status-"));
  dirs.push(dir);
  return { dir, exchanges: new ExchangeLog(dir) };
}
const idle = { turnRunning: () => false, printerLine: async () => null, now: () => NOW };

describe("checkEdmund", () => {
  test("idle, nothing waiting: two plain sentences", async () => {
    const { exchanges } = rig();
    expect(await checkEdmund({ exchanges, ...idle })).toBe(
      "Edmund is not working on anything right now. He has no new answers waiting.",
    );
  });

  test("says when a turn is running", async () => {
    const { exchanges } = rig();
    const out = await checkEdmund({ exchanges, ...idle, turnRunning: () => true });
    expect(out.startsWith("Edmund is working on something right now.")).toBe(true);
  });

  test("repeats the answers that were texted after the line closed, newest last", async () => {
    const { exchanges } = rig();
    exchanges.record({
      atMs: NOW - 40 * MIN,
      handle: "+15550100001",
      said: "find me a cabin near the lake",
      reply: "Three cabins, the cheapest is 140 a night.",
      via: "texted",
    });
    exchanges.record({
      atMs: NOW - 5 * MIN,
      handle: "+15550100001",
      said: "what is the plan for friday",
      reply: "Dinner at seven.",
      via: "texted",
    });
    const out = await checkEdmund({ exchanges, ...idle });
    expect(out).toContain("Edmund texted 2 answers after the line closed.");
    expect(out.indexOf("cabin")).toBeLessThan(out.indexOf("plan for friday"));
    expect(out).toContain("40 minutes ago");
    expect(out).toContain("5 minutes ago");
    expect(out).toContain("Three cabins");
  });

  test("answers already spoken on the line are not repeated", async () => {
    const { exchanges } = rig();
    exchanges.record({
      atMs: NOW - MIN,
      handle: "+15550100001",
      said: "what is 2+2",
      reply: "Four.",
      via: "spoken",
    });
    const out = await checkEdmund({ exchanges, ...idle });
    expect(out).not.toContain("Four");
    expect(out).toContain("no new answers");
  });

  test("a returned Grok Bot task is described as that, not as a question", async () => {
    const { exchanges } = rig();
    exchanges.record({
      atMs: NOW - 2 * MIN,
      handle: "+15550100001",
      said: "Grok Bot finished task gb-0123456789",
      reply: "The bot found the part in stock.",
      via: "texted",
      kind: "report",
    });
    const out = await checkEdmund({ exchanges, ...idle });
    expect(out).toContain("a Grok Bot's task came back");
    expect(out).toContain("in stock");
  });

  test("answers older than six hours are left out", async () => {
    const { exchanges } = rig();
    exchanges.record({
      atMs: NOW - 7 * 60 * MIN,
      handle: "+15550100001",
      said: "old",
      reply: "ancient answer",
      via: "texted",
    });
    expect(await checkEdmund({ exchanges, ...idle })).not.toContain("ancient");
  });

  test("only the last three answers, trimmed for the ear (no links or markdown)", async () => {
    const { exchanges } = rig();
    for (let i = 0; i < 5; i++) {
      exchanges.record({
        atMs: NOW - (10 - i) * MIN,
        handle: "+15550100001",
        said: `question ${i}`,
        reply:
          i === 4 ? `**Bold** see https://example.com/x for ${"more ".repeat(200)}` : `answer ${i}`,
        via: "texted",
      });
    }
    const out = await checkEdmund({ exchanges, ...idle });
    expect(out).toContain("Edmund texted 3 answers");
    expect(out).not.toContain("answer 0");
    expect(out).not.toContain("answer 1");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("**");
    expect(out.length).toBeLessThan(1_500);
  });

  test("adds the printer line when it is printing", async () => {
    const { exchanges } = rig();
    const out = await checkEdmund({
      exchanges,
      ...idle,
      printerLine: async () =>
        'The printer is printing "Benchy", 42 percent done, 31 minutes left.',
    });
    expect(out.endsWith("42 percent done, 31 minutes left.")).toBe(true);
  });

  test("a printer that hangs cannot hold the answer past a second", async () => {
    const { exchanges } = rig();
    const t0 = performance.now();
    const out = await checkEdmund({
      exchanges,
      ...idle,
      printerLine: () => new Promise<string | null>(() => {}),
    });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(out).toContain("not working on anything");
  });

  test("a printer that throws is just left out", async () => {
    const { exchanges } = rig();
    const out = await checkEdmund({
      exchanges,
      ...idle,
      printerLine: async () => {
        throw new Error("boom");
      },
    });
    expect(out).toContain("no new answers");
  });
});

describe("speakable", () => {
  test("links become 'a link', markdown links keep their words, emphasis marks go", () => {
    expect(
      speakable(
        "**Booked.** Details: https://example.com/a?b=1 and [the map](https://example.com/m).",
      ),
    ).toBe("Booked. Details: a link and the map.");
    expect(speakable("- one\n- two\n# Heading")).toBe("one\ntwo\nHeading");
    expect(speakable("plain words")).toBe("plain words");
  });
});

describe("agoPhrase", () => {
  test.each([
    [10_000, "Just now"],
    [MIN, "A minute ago"],
    [17 * MIN, "17 minutes ago"],
    [60 * MIN, "An hour ago"],
    [3 * 60 * MIN, "3 hours ago"],
  ])("%i ms", (ms, want) => expect(agoPhrase(ms)).toBe(want));
});

describe("printingLine", () => {
  test("is silent unless the printer is mid-job", () => {
    expect(printingLine(undefined)).toBeNull();
    expect(printingLine({ gcodeState: "IDLE" })).toBeNull();
    expect(printingLine({ gcodeState: "FINISH", percent: 100 })).toBeNull();
    expect(printingLine({ gcodeState: "FAILED" })).toBeNull();
    expect(printingLine({})).toBeNull();
  });

  test("one voice-friendly line", () => {
    expect(
      printingLine({ gcodeState: "RUNNING", taskName: "Benchy", percent: 41.6, remainingMin: 95 }),
    ).toBe('The printer is printing "Benchy", 42 percent done, 1 hours 35 minutes left.');
    expect(printingLine({ gcodeState: "PAUSE", percent: 10 }, "the Bambu")).toBe(
      "The Bambu is paused, 10 percent done.",
    );
  });
});

describe("printerLineFrom (the cheap loopback read)", () => {
  function printerDaemon(state: unknown, status = 200) {
    const { dir } = rig();
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push(req.headers.get("authorization"));
        return status === 200 ? Response.json({ state }) : new Response("no", { status });
      },
    });
    servers.push(server);
    mkdirSync(join(dir, "printer"), { recursive: true });
    writeFileSync(
      join(dir, "printer", "runtime.json"),
      JSON.stringify({ port: server.port, secret: "printer-secret" }),
    );
    return { dir, seen };
  }

  test("reads /api/state with the secret and returns the printing line", async () => {
    const { dir, seen } = printerDaemon({
      gcodeState: "RUNNING",
      taskName: "Vase",
      percent: 5,
      remainingMin: 20,
    });
    const line = await printerLineFrom(dir)();
    expect(line).toBe('The printer is printing "Vase", 5 percent done, 20 minutes left.');
    expect(seen).toEqual(["Bearer printer-secret"]);
  });

  test("idle printer, error status, no runtime file, bad json: all say nothing", async () => {
    const idleDaemon = printerDaemon({ gcodeState: "IDLE" });
    expect(await printerLineFrom(idleDaemon.dir)()).toBeNull();

    const denied = printerDaemon({}, 401);
    expect(await printerLineFrom(denied.dir)()).toBeNull();

    const { dir: none } = rig();
    expect(await printerLineFrom(none)()).toBeNull();

    const { dir: bad } = rig();
    mkdirSync(join(bad, "printer"), { recursive: true });
    writeFileSync(join(bad, "printer", "runtime.json"), "{not json");
    expect(await printerLineFrom(bad)()).toBeNull();
  });
});
