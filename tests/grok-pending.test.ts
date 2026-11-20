import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PENDING_TTL_MS,
  PendingTasks,
  cleanReplyId,
  newReplyId,
  parseOrigin,
} from "../src/grok/pending.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function rig(start = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "grok-pending-"));
  dirs.push(dir);
  let now = start;
  return {
    dir,
    advance: (ms: number) => {
      now += ms;
    },
    tasks: new PendingTasks(dir, () => now),
    // A second handle on the same file, as the daemon is to the MCP process.
    other: () => new PendingTasks(dir, () => now),
  };
}

describe("reply ids", () => {
  test("are short, prefixed and different every time", () => {
    const ids = new Set(Array.from({ length: 200 }, newReplyId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^gb-[0-9a-f]{10}$/);
  });

  test("tolerate the mangling a bot does: spaces, quotes, case, a trailing full stop", () => {
    expect(cleanReplyId(" GB-0123456789 ")).toBe("gb-0123456789");
    expect(cleanReplyId('"gb-0123456789".')).toBe("gb-0123456789");
    expect(cleanReplyId("`gb-0123456789`")).toBe("gb-0123456789");
  });
});

describe("PendingTasks", () => {
  test("an id that was never issued is unknown", () => {
    const { tasks } = rig();
    expect(tasks.lookup("gb-nope").status).toBe("unknown");
    expect(tasks.lookup("").status).toBe("unknown");
  });

  test("an added task is pending for 24 hours, then expired", () => {
    const { tasks, advance } = rig();
    const t = tasks.add({ replyId: "gb-aaaaaaaaaa", task: "find a cabin", bot: "main" });
    expect(t.expiresMs - t.createdMs).toBe(PENDING_TTL_MS);
    const found = tasks.lookup("gb-aaaaaaaaaa");
    expect(found.status).toBe("pending");
    advance(PENDING_TTL_MS - 1);
    expect(tasks.lookup("gb-aaaaaaaaaa").status).toBe("pending");
    advance(1);
    expect(tasks.lookup("gb-aaaaaaaaaa").status).toBe("expired");
    expect(tasks.open()).toEqual([]);
  });

  test("a result is recorded once; the id then reads as reported", () => {
    const { tasks } = rig();
    tasks.add({ replyId: "gb-bbbbbbbbbb", task: "t", bot: "main" });
    tasks.complete("gb-bbbbbbbbbb", "done: three cabins");
    tasks.complete("gb-bbbbbbbbbb", "a second, later answer");
    const found = tasks.lookup("gb-bbbbbbbbbb");
    expect(found.status).toBe("reported");
    if (found.status === "reported") expect(found.task.result).toBe("done: three cabins");
    expect(tasks.open()).toEqual([]);
  });

  test("the daemon's handle sees what the tool process wrote, and vice versa", () => {
    const { tasks, other } = rig();
    tasks.add({ replyId: "gb-cccccccccc", task: "t", bot: "main" });
    const daemon = other();
    expect(daemon.lookup("gb-cccccccccc").status).toBe("pending");
    daemon.complete("gb-cccccccccc", "ok");
    expect(tasks.lookup("gb-cccccccccc").status).toBe("reported");
  });

  test("lookup tolerates a mangled id", () => {
    const { tasks } = rig();
    tasks.add({ replyId: "gb-dddddddddd", task: "t", bot: "main" });
    expect(tasks.lookup('  "GB-DDDDDDDDDD".').status).toBe("pending");
  });

  test("a waiting call is flagged until it gives up", () => {
    const { tasks, advance } = rig();
    tasks.add({ replyId: "gb-eeeeeeeeee", task: "t", bot: "main", waitMs: 60_000 });
    const before = tasks.lookup("gb-eeeeeeeeee");
    expect(before.status === "pending" && before.task.waitUntilMs > 1_000_000).toBe(true);
    advance(5_000);
    tasks.stopWaiting("gb-eeeeeeeeee");
    const after = tasks.lookup("gb-eeeeeeeeee");
    expect(after.status === "pending" && after.task.waitUntilMs === 0).toBe(true);
  });

  test("a cancelled task (the webhook refused it) is as if it never existed", () => {
    const { tasks } = rig();
    tasks.add({ replyId: "gb-ffffffffff", task: "t", bot: "main" });
    tasks.cancel("gb-ffffffffff");
    expect(tasks.lookup("gb-ffffffffff").status).toBe("unknown");
  });

  test("open() lists what is still out, newest first", () => {
    const { tasks, advance } = rig();
    tasks.add({ replyId: "gb-1111111111", task: "first", bot: "main" });
    advance(1_000);
    tasks.add({ replyId: "gb-2222222222", task: "second", bot: "main" });
    advance(1_000);
    tasks.add({ replyId: "gb-3333333333", task: "third", bot: "main" });
    tasks.complete("gb-2222222222", "done");
    expect(tasks.open().map((t) => t.task)).toEqual(["third", "first"]);
  });

  test("a torn final line (a crash mid-write) does not lose the rest", () => {
    const { tasks, dir } = rig();
    tasks.add({ replyId: "gb-4444444444", task: "t", bot: "main" });
    appendFileSync(join(dir, "grok", "pending.jsonl"), '{"op":"done","replyId":"gb-44');
    expect(tasks.lookup("gb-4444444444").status).toBe("pending");
  });

  test("the file is private to its owner", () => {
    const { tasks, dir } = rig();
    tasks.add({ replyId: "gb-5555555555", task: "t", bot: "main" });
    const mode = Bun.file(join(dir, "grok", "pending.jsonl")).size;
    expect(mode).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "grok", "pending.jsonl"), "utf8")).not.toContain("webhook");
  });

  test("compaction drops what expired long ago and keeps the rest", () => {
    const { tasks, dir, advance } = rig();
    tasks.add({ replyId: "gb-old0000000", task: "old", bot: "main" });
    // Pad the log past the compaction threshold with junk lines.
    writeFileSync(
      join(dir, "grok", "pending.jsonl"),
      `${readFileSync(join(dir, "grok", "pending.jsonl"), "utf8")}${`${JSON.stringify({ op: "stopwait", replyId: "x", atMs: 1 })}\n`.repeat(20_000)}`,
    );
    advance(3 * PENDING_TTL_MS);
    tasks.add({ replyId: "gb-new0000000", task: "new", bot: "main" });
    expect(tasks.lookup("gb-old0000000").status).toBe("unknown");
    expect(tasks.lookup("gb-new0000000").status).toBe("pending");
    expect(readFileSync(join(dir, "grok", "pending.jsonl"), "utf8").length).toBeLessThan(2_000);
  });
});

describe("PendingTasks origin (where the task was asked from)", () => {
  const GROUP = {
    sessionKey: "imessage:group:any;+;chat42",
    chatGuid: "any;+;chat42",
    isGroup: true,
  };

  test("is stored on the task and read back by the other process", () => {
    const { tasks, other } = rig();
    tasks.add({ replyId: "gb-aaaaaaaaaa", task: "t", bot: "main", origin: GROUP });
    const found = other().lookup("gb-aaaaaaaaaa");
    expect(found.status === "pending" && found.task.origin).toEqual(GROUP);
  });

  test("a task without one has none (the owner's DM, as before)", () => {
    const { tasks } = rig();
    tasks.add({ replyId: "gb-bbbbbbbbbb", task: "t", bot: "main" });
    const found = tasks.lookup("gb-bbbbbbbbbb");
    expect(found.status === "pending" && "origin" in found.task).toBe(false);
  });

  test("an old JSONL line written before origins existed still loads, with no origin", () => {
    const { tasks, dir } = rig();
    mkdirSync(join(dir, "grok"), { recursive: true });
    writeFileSync(
      join(dir, "grok", "pending.jsonl"),
      `${JSON.stringify({ op: "add", replyId: "gb-old0000001", task: "legacy", bot: "main", createdMs: 1_000_000, expiresMs: 1_000_000 + PENDING_TTL_MS, waitUntilMs: 0 })}\n`,
    );
    const found = tasks.lookup("gb-old0000001");
    expect(found.status).toBe("pending");
    if (found.status === "pending") {
      expect(found.task.task).toBe("legacy");
      expect(found.task.origin).toBeUndefined();
    }
    tasks.complete("gb-old0000001", "done");
    expect(tasks.lookup("gb-old0000001").status).toBe("reported");
  });

  test("a malformed origin is dropped rather than trusted", () => {
    const { tasks, dir } = rig();
    mkdirSync(join(dir, "grok"), { recursive: true });
    const line = (replyId: string, origin: unknown) =>
      `${JSON.stringify({ op: "add", replyId, task: "t", bot: "main", origin, createdMs: 1_000_000, expiresMs: 1_000_000 + PENDING_TTL_MS, waitUntilMs: 0 })}\n`;
    writeFileSync(
      join(dir, "grok", "pending.jsonl"),
      line("gb-bad0000001", { sessionKey: "imessage:group:x", isGroup: "yes" }) +
        line("gb-bad0000002", "imessage:group:x") +
        line("gb-bad0000003", { sessionKey: "", chatGuid: "x", isGroup: true }),
    );
    for (const id of ["gb-bad0000001", "gb-bad0000002", "gb-bad0000003"]) {
      const found = tasks.lookup(id);
      expect(found.status === "pending" && found.task.origin).toBeUndefined();
    }
  });

  test("the origin survives a report and a compaction", () => {
    const { tasks, dir, advance } = rig();
    tasks.add({ replyId: "gb-keep0000001", task: "kept", bot: "main", origin: GROUP });
    tasks.complete("gb-keep0000001", "result");
    writeFileSync(
      join(dir, "grok", "pending.jsonl"),
      `${readFileSync(join(dir, "grok", "pending.jsonl"), "utf8")}${`${JSON.stringify({ op: "stopwait", replyId: "x", atMs: 1 })}\n`.repeat(20_000)}`,
    );
    advance(1_000);
    tasks.add({ replyId: "gb-keep0000002", task: "next", bot: "main", origin: GROUP }); // compacts
    expect(readFileSync(join(dir, "grok", "pending.jsonl"), "utf8").length).toBeLessThan(5_000);
    const kept = tasks.lookup("gb-keep0000001");
    expect(kept.status === "reported" && kept.task.origin).toEqual(GROUP);
    const next = tasks.lookup("gb-keep0000002");
    expect(next.status === "pending" && next.task.origin).toEqual(GROUP);
  });

  test("parseOrigin accepts only the full shape", () => {
    expect(parseOrigin(GROUP)).toEqual(GROUP);
    expect(parseOrigin({ ...GROUP, extra: 1 })).toEqual(GROUP);
    expect(parseOrigin(null)).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
    expect(parseOrigin({ sessionKey: "k", isGroup: true })).toBeNull();
    expect(parseOrigin({ sessionKey: "k", chatGuid: "g" })).toBeNull();
  });
});
