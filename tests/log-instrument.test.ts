/**
 * What a process does that no call site logs: requests out, requests in,
 * child processes, and the exception that ends it. Run in a child process,
 * because the hooks replace process-wide functions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelRecord, readChannel } from "../src/util/log-files.ts";
import { describeCommand, safePath } from "../src/util/log-instrument.ts";

const CHILD = join(import.meta.dir, "fixtures", "log-instrument-child.ts");

function run(ending: string): { dir: string; exitCode: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "log-instrument-"));
  const child = Bun.spawnSync([process.execPath, CHILD, dir, ending], { stderr: "pipe" });
  return { dir, exitCode: child.exitCode, stderr: child.stderr.toString() };
}

describe("a process that logs to files", () => {
  let dir = "";
  let all: (channel: Parameters<typeof readChannel>[1]) => ChannelRecord[];
  beforeAll(() => {
    const result = run("exit");
    expect(result.exitCode).toBe(0);
    dir = result.dir;
    all = (channel) => readChannel(dir, channel, 0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("records each outbound request, with the turn that made it and nothing secret", () => {
    const out = all("net-out");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      level: "info",
      session: "imessage:dm:+15550100001",
      turn: "model_turn_x",
      fields: { method: "POST", path: "/v1/items/abcdef…", status: 200 },
    });
    expect(out[1]).toMatchObject({ level: "warn", fields: { status: 403 } });
    expect(out[1]!.turn).toBeUndefined();
    expect(out[2]!.level).toBe("warn");
    expect(typeof out[2]!.fields!.err).toBe("string");
  });

  test("records each request a server answered, and copies a refusal to security", () => {
    const inbound = all("net-in");
    expect(inbound.map((r) => r.fields!.status)).toEqual([200, 403]);
    expect(inbound[0]!.fields).toMatchObject({
      server: "test-server",
      method: "POST",
      path: "/v1/items/abcdef…",
      ua: "test-agent",
    });
    expect(inbound[0]!.fields!.ip).toBeDefined();
    const denied = all("security");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.msg).toBe("test-server GET /private 403 denied");
  });

  test("records every child process however it was started", () => {
    const procs = all("proc").filter((r) => r.msg.startsWith("exit "));
    // spawnSync, execFileSync, spawnSync(sh), spawn, Bun.spawn, Bun.spawnSync, then two sleeps
    expect(procs.map((r) => r.fields!.cmd)).toEqual([
      "true",
      "true",
      "sh",
      "true",
      "echo",
      "true",
      "sleep",
      "sleep",
    ]);
    expect(procs[2]).toMatchObject({ level: "warn", fields: { code: 3 } });
    // Asked to stop is not a failure; killed is.
    expect(procs[6]).toMatchObject({ level: "info", fields: { signal: "SIGTERM" } });
    expect(procs[7]).toMatchObject({ level: "warn", fields: { signal: "SIGKILL" } });
    // The janitor ran gzip in that process, and that is not on record.
    expect(all("proc").some((r) => r.fields!.cmd === "gzip")).toBe(false);
    expect(procs[4]!.fields!.args).toBe("--token *** hello");
    for (const p of procs) expect(typeof p.fields!.ms).toBe("number");
  });

  test("no secret reached any file", () => {
    const everything = ["net-out", "net-in", "proc", "security", "error", "system"]
      .map((channel) => {
        try {
          return readFileSync(
            join(dir, "logs", channel, `${new Date().toISOString().slice(0, 10)}.jsonl`),
            "utf8",
          );
        } catch {
          return "";
        }
      })
      .join("");
    expect(everything.length).toBeGreaterThan(500);
    expect(everything).not.toContain("sk-secret-value");
    expect(everything).not.toContain("a body that must not be logged");
    expect(everything).not.toContain("abcdef0123456789");
  });

  test("records the exit", () => {
    expect(all("system").at(-1)).toMatchObject({ tag: "exit", fields: { code: 0 } });
  });
});

describe("a process that dies", () => {
  test("leaves the exception and its stack on record, and still dies", () => {
    const { dir, exitCode, stderr } = run("throw");
    try {
      expect(exitCode).toBe(1);
      expect(stderr).toContain("the daemon fell over");
      const fatal = readChannel(dir, "error", 0).filter((r) => r.tag === "fatal");
      expect(fatal).toHaveLength(1);
      expect(fatal[0]!.msg).toContain("the daemon fell over");
      expect(String(fatal[0]!.fields!.stack)).toContain("log-instrument-child.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rejected request nobody handles ends the process as it did before", () => {
    const plain = Bun.spawnSync(
      [process.execPath, "-e", 'void fetch("http://127.0.0.1:9/nobody-handles-this")'],
      { stderr: "pipe" },
    );
    const { dir, exitCode } = run("reject");
    try {
      expect(exitCode).toBe(plain.exitCode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what is kept of a path and a command line", () => {
  test("opaque path segments are cut; ordinary ones are kept", () => {
    expect(safePath("/v1/messages")).toBe("/v1/messages");
    expect(safePath("/s/0f66f61026db697ea6c05ccfc2aea69a/index.html")).toBe(
      "/s/0f66f6…/index.html",
    );
    expect(safePath("/portal/a-very-long-but-ordinary-page-name")).toBe(
      "/portal/a-very-long-but-ordinary-page-name",
    );
  });

  test("a command keeps its program and first arguments, without secrets or long text", () => {
    expect(describeCommand(["/usr/bin/osascript", "-e", "x".repeat(500)])).toEqual({
      cmd: "osascript",
      args: `-e ${"x".repeat(60)}…`,
    });
    expect(describeCommand(["curl", "--api-key", "abc123", "https://example.com"]).args).toBe(
      "--api-key *** https://example.com",
    );
    expect(describeCommand(["claude", "a", "b", "c", "d", "e", "f"]).args).toBe(
      "a b c d (+2 more)",
    );
  });
});
