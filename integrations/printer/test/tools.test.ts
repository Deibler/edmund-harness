import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolResult } from "../../../src/mcp/tools/types.ts";
import { trayLabel } from "../src/describe.ts";
import { printerTools } from "../tools.ts";

const dir = mkdtempSync(join(tmpdir(), "printer-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function tools(sessionKey: string) {
  const ctx = {
    config: {
      printer: { enabled: true, host: "192.0.2.1", access_code: "12345678", serial: "SERIAL" },
      security: { operator_handles: ["+15555550100"] },
      alerts: { operator_handle: "" },
      owner: { name: "Alex Example" },
      shelf: { origin: "" },
      claude: { model: "m", agent_model: "" },
      paths: { chat_db: join(dir, "none.db"), data_dir: dir },
    },
    sessionKey,
    chatGuids: [],
    sandboxPath: dir,
    dataDir: dir,
  } as unknown as ToolContext;
  return Object.fromEntries(printerTools(ctx).map((t) => [t.name, t]));
}
const textOf = (r: ToolResult) =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("the tool surface", () => {
  const t = tools("imessage:dm:+15555550101");

  test("every tool the manifest promises exists, and nothing else", () => {
    const manifest = readFileSync(join(import.meta.dir, "..", "manifest.yaml"), "utf8");
    const promised = [...manifest.matchAll(/^\s+- ((?:printer|print|makerworld)_[a-z_]+)$/gm)]
      .map((m) => m[1])
      .sort();
    expect(Object.keys(t).sort()).toEqual(promised as string[]);
  });

  test("there is no pause, even when asked for one outside the schema", async () => {
    const r = await t.print_control!.handler({ action: "pause" } as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("never pauses");
  });

  test("the approval tool names the approver from config", () => {
    expect(t.print_request_approval!.description).toContain("Ask Alex to approve");
  });

  test("MakerWorld sign-in and packaging belong to the approver's own DM", async () => {
    expect(
      textOf(await t.makerworld_login!.handler({ action: "send_code", email: "a@example.com" })),
    ).toContain("Only Alex");
    expect(textOf(await t.makerworld_package!.handler({ title: "x", summary: "y" }))).toContain(
      "Only Alex",
    );
    const mine = tools("imessage:dm:+15555550100");
    expect(
      textOf(await mine.makerworld_login!.handler({ action: "verify", email: "a@example.com" })),
    ).toContain("Give the code");
  });

  test("error codes decode without a printer", async () => {
    expect(textOf(await t.printer_error_lookup!.handler({ code: "0300-400C" }))).toContain(
      "The task was canceled.",
    );
  });

  test("a disabled section exposes no tools", () => {
    const ctx = { config: { printer: { enabled: false } } } as unknown as ToolContext;
    expect(printerTools(ctx)).toEqual([]);
  });

  test("trays are named the way a person finds them", () => {
    expect(trayLabel(3)).toBe("AMS 1 slot 4");
    expect(trayLabel(4)).toBe("AMS 2 slot 1");
    expect(trayLabel(255)).toBe("the external spool");
  });
});
