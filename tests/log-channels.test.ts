/**
 * Every log tag in the code is filed under a channel, and a turn can be read
 * back across the channels.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTrace,
  formatRecord,
  parseMoment,
  parseSpan,
} from "../cli/commands/log-channels.ts";
import {
  CHANNEL_NAMES,
  channelForTag,
  isFiledTag,
  isSecurityEvent,
} from "../src/util/log-channels.ts";
import { beginTurn, endTurn, withLogContext } from "../src/util/log-context.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";
import { log } from "../src/util/log.ts";

const ROOT = join(import.meta.dir, "..");

describe("filing", () => {
  /** Tags as the code writes them: log.info("tag", …) and console.log("[tag] …"). */
  function tagsInCode(): Map<string, string> {
    const tags = new Map<string, string>();
    const patterns = [
      /\blog\.(?:info|warn|error|debug)\(\s*"([^"]+)"/g,
      /\bconsole\.(?:log|info|warn|error)\(\s*[`"']\[([A-Za-z0-9_:./-]+)\]/g,
    ];
    for (const top of ["src", "scripts", "dashboard/server", "integrations"]) {
      for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: join(ROOT, top) })) {
        const file = `${top}/${rel}`;
        if (file.includes(".test.") || file.includes("/test/") || file.includes("node_modules")) {
          continue;
        }
        const text = readFileSync(join(ROOT, file), "utf8");
        for (const pattern of patterns) {
          for (const m of text.matchAll(pattern)) tags.set(m[1]!, file);
        }
      }
    }
    return tags;
  }

  test("every tag in the code has a channel", () => {
    const unfiled = [...tagsInCode()]
      .filter(([tag]) => !isFiledTag(tag))
      .map(([tag, file]) => `${tag} (${file})`);
    expect(unfiled).toEqual([]);
  });

  test("the scan reads the tags it is meant to", () => {
    const tags = tagsInCode();
    expect(tags.size).toBeGreaterThan(100);
    for (const tag of ["cron", "claude-worker", "recall", "gate", "printer"]) {
      expect(tags.has(tag)).toBe(true);
    }
  });

  test("a tag goes to its channel, an unknown one to misc", () => {
    expect(channelForTag("claude-worker")).toBe("model");
    expect(channelForTag("cron")).toBe("cron");
    expect(channelForTag("gate")).toBe("security");
    expect(channelForTag("ghost-observer")).toBe("ghost");
    expect(channelForTag("something-new")).toBe("misc");
    expect(CHANNEL_NAMES).toContain("net-out");
  });

  test("what counts as a security event", () => {
    for (const line of [
      "send refused: chat_mismatch",
      "dm:+15550100004 dropped — tier revoked",
      "dm:+15550100004 capped (daily)",
      "portal GET /p 403 denied",
      "invalid PIN from 203.0.113.9",
    ]) {
      expect(isSecurityEvent(line)).toBe(true);
    }
    for (const line of [
      "connect ECONNREFUSED 10.0.0.9:8883",
      "fire ok",
      "turn refusedly named",
      "booted cursor=1 provider=claude watcher=auto allowlist=0dm/0g contacts=1",
    ]) {
      expect(isSecurityEvent(line)).toBe(false);
    }
  });
});

describe("reading the flags", () => {
  test("spans", () => {
    expect(parseSpan("90s")).toBe(90_000);
    expect(parseSpan("30m")).toBe(1_800_000);
    expect(parseSpan("2h")).toBe(7_200_000);
    expect(parseSpan("3d")).toBe(259_200_000);
    expect(parseSpan("soon")).toBeNull();
  });

  test("a clock time is today, or yesterday when it has not happened yet", () => {
    const now = new Date(2026, 10, 25, 15, 0, 0).getTime();
    expect(parseMoment("14:05", now)).toBe(new Date(2026, 10, 25, 14, 5, 0).getTime());
    expect(parseMoment("23:30:10", now)).toBe(new Date(2026, 10, 24, 23, 30, 10).getTime());
    expect(parseMoment("2026-11-01T06:54:00Z", now)).toBe(Date.parse("2026-11-01T06:54:00Z"));
    expect(parseMoment("lunchtime", now)).toBeNull();
  });
});

describe("tracing", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "log-trace-"));
    installLogSink(dir, "", "daemon.log", { echo: false, instrument: false });
  });
  afterEach(() => {
    uninstallLogSink();
    rmSync(dir, { recursive: true, force: true });
  });

  const SAM = "imessage:dm:+15550100001";
  const PAT = "imessage:dm:+15550100002";

  function aTurn() {
    beginTurn(SAM, "model_turn_sam1");
    log.event("model", "turn", "turn start", { session: SAM, turn: "model_turn_sam1" });
    withLogContext({ session: SAM, turn: "model_turn_sam1" }, () => {
      log.info("recall", "injected", { hits: 2 });
      log.event("net-out", "net-out", "POST api.example.com/v1/embed", { status: 200, ms: 40 });
    });
    log.info("claude-worker", "tool_use Bash", { session: "dm:+15550100001" });
    log.event("browse", "browse", "fetch https://example.com/tides", { session: SAM });
    log.warn("send", "send refused: chat_mismatch", { session: SAM });
    // Meanwhile, elsewhere:
    log.info("claude-worker", "tool_use Read", { session: PAT });
    log.event("resource", "sample", "sample tree=900MB");
    log.event("proc", "proc", "exit osascript", { code: 0 });
    endTurn(SAM, "model_turn_sam1");
  }

  test("a turn id gathers that turn from every channel, once each, in order", () => {
    aTurn();
    const result = collectTrace(dir, "model_turn_sam1", { minutes: 10, all: false });
    expect(result.turns).toEqual(["model_turn_sam1"]);
    expect(result.sessions).toEqual([SAM, "dm:+15550100001"]);
    const mine = result.records.filter((r) => r.turn === "model_turn_sam1");
    expect(mine.map((r) => r.ch)).toEqual([
      "model",
      "memory",
      "net-out",
      "model",
      "browse",
      "message",
    ]);
    // The refusal is in message, error and security: shown once.
    expect(result.records.filter((r) => r.msg.includes("chat_mismatch"))).toHaveLength(1);
    // The other conversation's line is not in it; what belongs to no conversation and explains one is.
    expect(result.records.some((r) => r.session === PAT)).toBe(false);
    expect(result.records.some((r) => r.ch === "resource")).toBe(true);
    expect(result.records.some((r) => r.ch === "proc")).toBe(false);
  });

  test("part of a name gathers a conversation around a time; --all adds everything else in the window", () => {
    aTurn();
    const narrow = collectTrace(dir, "0100001", { minutes: 5, all: false });
    expect(
      narrow.records.filter((r) => r.session).every((r) => r.session!.includes("0100001")),
    ).toBe(true);
    expect(narrow.records.some((r) => r.ch === "browse")).toBe(true);
    const wide = collectTrace(dir, "0100001", { minutes: 5, all: true });
    expect(wide.records.some((r) => r.ch === "proc")).toBe(true);
    expect(
      collectTrace(dir, "0100001", { atMs: Date.now() - 3_600_000, minutes: 5, all: false })
        .records,
    ).toEqual([]);
  });

  test("a turn nobody ran finds nothing", () => {
    aTurn();
    expect(collectTrace(dir, "model_turn_nope", { minutes: 10, all: false }).records).toEqual([]);
  });

  test("a record prints on one line with its fields", () => {
    aTurn();
    const record = collectTrace(dir, "model_turn_sam1", { minutes: 10, all: false }).records.find(
      (r) => r.ch === "net-out",
    )!;
    const line = formatRecord(record, true).replace(/\x1b\[[0-9;]*m/g, "");
    expect(line).toContain("net-out");
    expect(line).toContain("dm:+15550100001");
    expect(line).toContain("POST api.example.com/v1/embed  status=200 ms=40");
    expect(line).not.toContain("\n");
  });
});
