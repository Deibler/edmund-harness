import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runMcpStdioSmoke = process.env.RUN_MCP_STDIO_SMOKE === "1";

/**
 * stdout is the JSON-RPC transport in a stdio MCP server. A stray console.log
 * in a tool handler used to land directly in that stream. These tests pin the
 * guard that stops it, and — more importantly — assert the property at the
 * process level, since the guard is only worth anything if it survives a real
 * SDK stdio server.
 */
describe("protectStdout", () => {
  test("redirects console.log/info/debug/warn to stderr", async () => {
    const { protectStdout } = await import("../src/mcp/stdio-safety.ts");

    const original = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      write: process.stderr.write,
    };
    const captured: string[] = [];
    let stdoutWrites = 0;
    const originalStdoutWrite = process.stdout.write;

    try {
      // @ts-expect-error narrowing the overloaded write signature for the spy
      process.stderr.write = (chunk: string) => {
        captured.push(String(chunk));
        return true;
      };
      // @ts-expect-error same
      process.stdout.write = () => {
        stdoutWrites++;
        return true;
      };

      protectStdout();
      console.log("plain line");
      console.info("info line");
      console.debug("debug line");
      console.warn("warn line");
      console.log("obj", { a: 1 });
    } finally {
      process.stderr.write = original.write;
      process.stdout.write = originalStdoutWrite;
      console.log = original.log;
      console.info = original.info;
      console.debug = original.debug;
      console.warn = original.warn;
    }

    expect(stdoutWrites).toBe(0);
    expect(captured.join("")).toContain("plain line");
    expect(captured.join("")).toContain("info line");
    expect(captured.join("")).toContain("debug line");
    expect(captured.join("")).toContain("warn line");
    expect(captured.join("")).toContain('obj {"a":1}');
  });

  test("does not throw on circular objects", async () => {
    const { protectStdout } = await import("../src/mcp/stdio-safety.ts");
    const original = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
    };
    const originalWrite = process.stderr.write;
    try {
      // @ts-expect-error spy signature
      process.stderr.write = () => true;
      protectStdout();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => console.log("circular", circular)).not.toThrow();
    } finally {
      process.stderr.write = originalWrite;
      console.log = original.log;
      console.info = original.info;
      console.debug = original.debug;
      console.warn = original.warn;
    }
  });

  describe.if(runMcpStdioSmoke)("process smoke", () => {
    test("MCP server emits only JSON-RPC frames on stdout", async () => {
      // End-to-end: drive a real SDK server over stdio with an initialize +
      // tools/list, and assert every stdout line parses as JSON. The fixture
      // deliberately logs during startup; before the guard, that plain text
      // corrupted the protocol stream.
      const repo = fileURLToPath(new URL("..", import.meta.url));
      const serverEntry = fileURLToPath(new URL("./fixtures/mcp-stdio-server.ts", import.meta.url));
      const sandbox = mkdtempSync(join(tmpdir(), "edmund-mcp-stdio-"));
      const requestsPath = join(sandbox, "requests.jsonl");
      writeFileSync(
        requestsPath,
        `${[
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "test", version: "0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ]
          .map((message) => JSON.stringify(message))
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const nodeExecutable = Bun.which("node");
      if (!nodeExecutable) throw new Error("node executable required for stdio fixture");
      const proc = Bun.spawn([nodeExecutable, serverEntry], {
        cwd: repo,
        stdin: Bun.file(requestsPath),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          EDMUND_SESSION_KEY: "imessage:dm:+15550100001",
          EDMUND_SANDBOX_PATH: sandbox,
        },
      });

      let stdout = "";
      let exitCode: number | null = null;
      try {
        [stdout, , exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
      } finally {
        proc.kill();
        rmSync(sandbox, { recursive: true, force: true });
      }

      expect(exitCode).toBe(0);
      const lines = stdout.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThan(0);
      const nonJson = lines.filter((l) => {
        try {
          JSON.parse(l);
          return false;
        } catch {
          return true;
        }
      });
      expect(nonJson).toEqual([]);
      expect(stdout).not.toContain("stdio fixture startup diagnostic");
    }, 30_000);
  });

  describe.if(!runMcpStdioSmoke)("process smoke", () => {
    test("skipped — set RUN_MCP_STDIO_SMOKE=1 to run the subprocess framing check", () => {
      expect(true).toBe(true);
    });
  });
});
