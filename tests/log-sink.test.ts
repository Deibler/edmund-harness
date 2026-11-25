/**
 * The log sink: one operational log that reads as it always has, and a
 * record of each line filed under its channel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTurn, endTurn, withLogContext } from "../src/util/log-context.ts";
import {
  type ChannelRecord,
  dayBefore,
  readChannel,
  readOpsLog,
  runLogJanitor,
  utcDay,
} from "../src/util/log-files.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";
import { log } from "../src/util/log.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-sink-"));
});
afterEach(() => {
  uninstallLogSink();
  rmSync(dir, { recursive: true, force: true });
});

const install = (options = {}) =>
  installLogSink(dir, "", "daemon.log", { echo: false, instrument: false, ...options });
const ops = () => readFileSync(join(dir, "daemon.log"), "utf8").split("\n").filter(Boolean);
const records = (channel: Parameters<typeof readChannel>[1]): ChannelRecord[] =>
  readChannel(dir, channel, 0);

describe("one line, two places", () => {
  test("the operational log line keeps its shape; the channel record keeps the fields", () => {
    install();
    log.info("cron", "fire ok", { job: "job_1", session: "imessage:dm:+15550100001", ms: 42 });
    const [line] = ops();
    expect(line).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[log\] \[cron\] fire ok job=job_1 session=dm:\+15550100001 ms=42$/,
    );
    const [record] = records("cron");
    expect(record).toMatchObject({
      level: "info",
      ch: "cron",
      tag: "cron",
      msg: "fire ok",
      proc: "daemon",
      session: "imessage:dm:+15550100001",
      fields: { job: "job_1", ms: 42 },
    });
    expect(record!.pid).toBe(process.pid);
  });

  test("a line printed with console is filed by the tag it starts with", () => {
    install();
    console.warn("[recall] coverage was slow session=dm:+15550100002 ms=900");
    console.log("no tag at all");
    expect(ops()).toHaveLength(2);
    expect(ops()[0]).toContain(" [warn] [recall] coverage was slow");
    expect(records("memory")[0]).toMatchObject({
      level: "warn",
      tag: "recall",
      session: "dm:+15550100002",
    });
    expect(records("misc")[0]).toMatchObject({ tag: "", msg: "no tag at all" });
  });

  test("a subprocess is named by its prefix and serves one conversation", () => {
    install();
    uninstallLogSink();
    installLogSink(dir, "mcp[dm:+15550100003] ", "daemon.log", {
      echo: false,
      instrument: false,
      session: "imessage:dm:+15550100003",
    });
    log.info("tool", "✓ send_message", { dur: "51ms" });
    expect(ops()[0]).toContain(" [log] mcp[dm:+15550100003] [tool] ✓ send_message dur=51ms");
    expect(records("tool")[0]).toMatchObject({
      proc: "mcp",
      session: "imessage:dm:+15550100003",
    });
  });

  test("a channel-only event is on record and not in the operational log", () => {
    install();
    log.event("net-out", "net-out", "GET api.example.com/v1/models", { status: 200, ms: 12 });
    expect(existsSync(join(dir, "daemon.log"))).toBe(false);
    expect(records("net-out")[0]).toMatchObject({ msg: "GET api.example.com/v1/models" });
  });

  test("without a sink nothing is written and the logger still prints", () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: string) => void printed.push(line);
    try {
      log.info("cron", "fire ok", { job: "job_1" });
      log.event("net-out", "net-out", "GET example.com/");
    } finally {
      console.log = original;
    }
    expect(printed).toEqual(["[cron] fire ok job=job_1"]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("copies for the two questions asked first", () => {
  test("every warning and error is also in the error channel", () => {
    install();
    log.info("cron", "fire ok");
    log.warn("cron", "skip stale job");
    log.error("claude", "turn failed", { err: new Error("boom") });
    const errors = records("error");
    expect(errors.map((r) => r.msg)).toEqual(["skip stale job", "turn failed"]);
    expect(errors[1]!.ch).toBe("model");
    expect((errors[1]!.fields!.err as { stack: string }).stack).toContain("boom");
  });

  test("a refusal anywhere is also in the security channel; a refused connection is not", () => {
    install();
    log.warn("send", "send refused: chat_mismatch", { session: "imessage:dm:+15550100001" });
    log.info("printer", "printer connect failed: connect ECONNREFUSED 10.0.0.9:8883");
    console.log("[guest] dm:+15550100004 capped (daily): over the limit");
    expect(records("security").map((r) => r.tag)).toEqual(["send", "guest"]);
  });
});

describe("what a field may show", () => {
  test("counts and session keys are shown; credentials are not", () => {
    install();
    log.info("claude", "result", {
      tokens: 51234,
      first_token: "1.2s",
      key: "imessage:dm:+15550100001",
      api_key: "sk-live-abcdefghijklmnop",
      token: "abcdefghijklmnopqrstuvwxyz",
    });
    const line = ops()[0]!;
    expect(line).toContain("tokens=51234");
    expect(line).toContain("first_token=1.2s");
    expect(line).toContain("key=imessage:dm:+15550100001");
    expect(line).toContain("api_key=***");
    expect(line).toContain("token=***");
    expect(line).not.toContain("sk-live");
    const fields = records("model")[0]!.fields!;
    expect(fields).toMatchObject({ tokens: 51234, api_key: "***", token: "***" });
  });
});

describe("which turn a record belongs to", () => {
  test("a record written inside a turn carries it; one that only names the conversation finds it", async () => {
    install();
    const session = "imessage:dm:+15550100001";
    beginTurn(session, "model_turn_a");
    await withLogContext({ session, turn: "model_turn_a" }, async () => {
      await Bun.sleep(1);
      log.info("recall", "injected", { hits: 3 });
    });
    // The worker's stream handler runs outside that flow and names the session in short form.
    log.info("claude-worker", "tool_use Bash", { session: "dm:+15550100001" });
    endTurn(session, "model_turn_a");
    log.info("claude-worker", "idle", { session: "dm:+15550100001" });
    expect(records("memory")[0]).toMatchObject({ session, turn: "model_turn_a" });
    const model = records("model");
    expect(model[0]!.turn).toBe("model_turn_a");
    expect(model[1]!.turn).toBeUndefined();
  });

  test("a line about another conversation does not borrow the running turn", () => {
    install();
    withLogContext({ session: "imessage:dm:+15550100001", turn: "model_turn_a" }, () => {
      log.info("cron", "fire ok", { session: "imessage:dm:+15550100009" });
    });
    expect(records("cron")[0]).toMatchObject({ session: "imessage:dm:+15550100009" });
    expect(records("cron")[0]!.turn).toBeUndefined();
  });
});

describe("a flood", () => {
  test("one shape repeated is cut off and counted; other lines are untouched", () => {
    install();
    for (let i = 0; i < 20_000; i++) {
      log.warn("cron", `skip stale job (${60 + (i % 20)}m late, grace=30m)`, { job: "job_1" });
    }
    log.info("cron", "fire ok");
    const lines = ops();
    const flood = lines.filter((l) => l.includes("skip stale job") && !l.includes("[log]"));
    expect(flood.length).toBe(200);
    expect(lines.at(-1)).toContain("[cron] fire ok");
    expect(records("cron").length).toBe(201);
  });

  test("while it lasts it gets a trickle and a count; when it stops the count is still written", async () => {
    install();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let window = 0; window < 4; window++) {
        for (let i = 0; i < 1_000; i++)
          log.warn("printer", "printer connection dropped; reconnecting");
        now += 10_001;
      }
      log.info("printer", "connected");
    } finally {
      Date.now = realNow;
    }
    const lines = ops();
    const drops = lines.filter((l) => l.includes("connection dropped") && !l.includes("[log]"));
    // 200 in the first ten seconds, then 5 in each of the next three.
    expect(drops.length).toBe(215);
    const notices = lines.filter((l) => l.includes("[log] suppressed"));
    expect(notices.length).toBe(3);
    expect(notices[0]).toContain("suppressed 800 more lines");
    expect(notices[1]).toContain("suppressed 995 more lines");
    expect(records("system").filter((r) => r.tag === "log").length).toBe(3);
  });
});

describe("rotation", () => {
  const stamp = (day: string, n: number) => `${day}T10:00:${String(n).padStart(2, "0")}.000Z`;

  test("a log that began on an earlier day is filed by day, and reading back finds it", async () => {
    const today = utcDay();
    const yesterday = dayBefore(today, 1);
    const before = dayBefore(today, 2);
    writeFileSync(
      join(dir, "daemon.log"),
      [
        `${stamp(before, 1)} [log] [cron] two days ago`,
        "    at a continuation line with no timestamp",
        `${stamp(yesterday, 1)} [log] [cron] yesterday`,
        `${stamp(yesterday, 2)} [log] [cron] yesterday again`,
        "",
      ].join("\n"),
    );
    install({ rotate: true });
    log.info("cron", "today");
    await Bun.sleep(100);
    expect(ops()).toHaveLength(1);
    const filed = join(dir, "logs", "daemon");
    expect(readdirSync(filed).sort()).toEqual([`${before}.log`, `${yesterday}.log`]);
    expect(readFileSync(join(filed, `${before}.log`), "utf8")).toContain("continuation line");
    const week = readOpsLog(dir, Date.now() - 7 * 86_400_000);
    expect(week.split("\n").filter(Boolean)).toHaveLength(5);
    expect(
      readOpsLog(dir, Date.parse(`${yesterday}T00:00:00Z`))
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(3);
  });

  test("lines older than the retention window go to the archive, which is kept", async () => {
    const today = utcDay();
    const old = dayBefore(today, 90);
    const older = dayBefore(today, 200);
    const recent = dayBefore(today, 3);
    writeFileSync(
      join(dir, "daemon.log"),
      `${stamp(older, 1)} [log] [cron] ancient\n${stamp(old, 1)} [log] [cron] old\n${stamp(recent, 1)} [log] [cron] recent\n`,
    );
    install({ rotate: true, retentionDays: 30 });
    await Bun.sleep(100);
    expect(readdirSync(join(dir, "logs", "daemon"))).toEqual([`${recent}.log`]);
    expect(readdirSync(join(dir, "logs", "archive"))).toEqual([`daemon-${older}_to_${old}.log`]);
    const report = await runLogJanitor(dir, {
      retentionDays: 30,
      compressAfterDays: 2,
      maxTotalMb: 100,
      captureMaxMb: 20,
    });
    expect(report.errors).toEqual([]);
    expect(readdirSync(join(dir, "logs", "archive"))).toEqual([`daemon-${older}_to_${old}.log.gz`]);
    expect(readdirSync(join(dir, "logs", "daemon"))).toEqual([`${recent}.log.gz`]);
    // Compressed days still read back.
    expect(readOpsLog(dir, Date.now() - 7 * 86_400_000)).toContain("recent");
  });

  test("a log that began today stays where it is", () => {
    writeFileSync(join(dir, "daemon.log"), `${stamp(utcDay(), 1)} [log] [cron] earlier today\n`);
    install({ rotate: true });
    log.info("cron", "now");
    expect(ops()).toHaveLength(2);
    expect(existsSync(join(dir, "logs", "daemon"))).toBe(false);
  });
});

describe("the janitor", () => {
  const policy = { retentionDays: 30, compressAfterDays: 2, maxTotalMb: 100, captureMaxMb: 1 };

  function channelDay(channel: string, day: string, bytes = 64): string {
    const folder = join(dir, "logs", channel);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${day}.jsonl`);
    const record = JSON.stringify({
      ts: `${day}T12:00:00.000Z`,
      level: "info",
      ch: channel,
      tag: "t",
      msg: "m",
      proc: "daemon",
      pid: 1,
    });
    writeFileSync(path, `${record}\n`.padEnd(bytes, " "));
    return path;
  }

  test("past retention is removed, past two days is compressed, today is left alone", async () => {
    const today = utcDay();
    channelDay("cron", dayBefore(today, 45));
    channelDay("cron", dayBefore(today, 10));
    channelDay("cron", dayBefore(today, 1));
    channelDay("cron", today);
    const report = await runLogJanitor(dir, policy);
    expect(report).toMatchObject({ removed: 1, compressed: 1, errors: [] });
    expect(readdirSync(join(dir, "logs", "cron")).sort()).toEqual(
      [`${dayBefore(today, 10)}.jsonl.gz`, `${dayBefore(today, 1)}.jsonl`, `${today}.jsonl`].sort(),
    );
    expect(readChannel(dir, "cron", 0)).toHaveLength(3);
  });

  test("over the size cap the oldest days go first, in every channel", async () => {
    const today = utcDay();
    const half = 600 * 1024;
    channelDay("cron", dayBefore(today, 5), half);
    channelDay("model", dayBefore(today, 4), half);
    channelDay("cron", dayBefore(today, 1), half);
    await runLogJanitor(dir, { ...policy, compressAfterDays: 30, maxTotalMb: 1 });
    expect(readdirSync(join(dir, "logs", "cron"))).toEqual([`${dayBefore(today, 1)}.jsonl`]);
    expect(readdirSync(join(dir, "logs", "model"))).toEqual([]);
  });

  test("a log another program appends to is archived and emptied once it is large", async () => {
    const capture = join(dir, "launchd.err.log");
    writeFileSync(capture, "a crash report\n".repeat(100_000));
    writeFileSync(join(dir, "small.launchd.log"), "fine\n");
    writeFileSync(join(dir, "daemon.log"), "x".repeat(2_000_000));
    utimesSync(capture, new Date(), new Date());
    const report = await runLogJanitor(dir, policy);
    expect(report.captured).toEqual(["launchd.err.log"]);
    expect(readFileSync(capture, "utf8")).toBe("");
    expect(readFileSync(join(dir, "small.launchd.log"), "utf8")).toBe("fine\n");
    // The sink's own file is rotated by the sink, never emptied from outside.
    expect(readFileSync(join(dir, "daemon.log"), "utf8").length).toBe(2_000_000);
    const [archived] = readdirSync(join(dir, "logs", "archive"));
    expect(archived).toMatch(/^launchd\.err-until-.*\.log\.gz$/);
    const restored = Buffer.from(
      Bun.gunzipSync(readFileSync(join(dir, "logs", "archive", archived!))),
    ).toString();
    expect(restored.length).toBe("a crash report\n".length * 100_000);
  });
});
