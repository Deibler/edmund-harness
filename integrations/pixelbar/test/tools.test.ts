import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolResult } from "../../../src/mcp/tools/types.ts";
import { pixelbarTools } from "../tools.ts";

// A stand-in for the bar: records what it was asked, answers as the firmware does.
type Seen = { path: string; auth: string | null; type: string | null; body: unknown };
const seen: Seen[] = [];
let answer: { status: number; body: string } = { status: 200, body: '{"ok":true,"result":"ok"}' };
const bar = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push({
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization"),
      type: req.headers.get("content-type"),
      body: await req.json(),
    });
    return new Response(answer.body, { status: answer.status });
  },
});
afterAll(() => bar.stop(true));

function tools(section: Record<string, unknown>) {
  const ctx = { config: { pixelbar: section } } as unknown as ToolContext;
  return Object.fromEntries(pixelbarTools(ctx).map((t) => [t.name, t]));
}
const live = { enabled: true, url: `http://localhost:${bar.port}/`, key: "KEY12345" };
const textOf = (r: ToolResult) =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("the tool surface", () => {
  test("every tool the manifest promises exists, and nothing else", () => {
    const manifest = readFileSync(join(import.meta.dir, "..", "manifest.yaml"), "utf8");
    const promised = [...manifest.matchAll(/^\s+- (pixelbar_[a-z_]+)$/gm)].map((m) => m[1]).sort();
    expect(promised.length).toBeGreaterThan(0);
    expect(Object.keys(tools(live)).sort()).toEqual(promised as string[]);
  });

  test("switched off in config, it contributes no tools", () => {
    expect(Object.keys(tools({ enabled: false, key: "KEY12345" }))).toEqual([]);
    expect(Object.keys(tools({}))).toEqual([]);
  });
});

describe("a call", () => {
  test("goes to the bar's own tool, with the key and the arguments as JSON", async () => {
    const t = tools(live);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["pixelbar_state", "get_state", {}],
      ["pixelbar_status", "set_status", { status: "working", note: "slicing", ttl_s: 120 }],
      ["pixelbar_text", "show_text", { text: "HELLO", hue: 200, notify: true }],
      ["pixelbar_progress", "show_progress", { fraction: 0.4, label: "render" }],
      ["pixelbar_timer", "set_timer", { seconds: 300 }],
      ["pixelbar_mode", "set_mode", { mode: "scenes", scene: "lava lamp" }],
      ["pixelbar_clear", "clear", {}],
    ];
    for (const [name, device, args] of cases) {
      seen.length = 0;
      const r = await t[name]!.handler(args as never);
      expect(r.isError).toBeUndefined();
      expect(seen).toEqual([
        { path: `/api/${device}`, auth: "Bearer KEY12345", type: "application/json", body: args },
      ]);
    }
  });

  test("returns the bar's answer: its result text, or its state as it sent it", async () => {
    const t = tools(live);
    answer = { status: 200, body: '{"ok":true,"result":"ok: showing"}' };
    expect(textOf(await t.pixelbar_text!.handler({ text: "HI" } as never))).toBe("ok: showing");
    answer = { status: 200, body: '{"mode":"CLOCK","brightness_pct":40}' };
    expect(textOf(await t.pixelbar_state!.handler({} as never))).toBe(
      '{"mode":"CLOCK","brightness_pct":40}',
    );
    answer = { status: 200, body: '{"ok":true,"result":"ok"}' };
  });

  test("a refusal is the bar's own sentence, marked as an error", async () => {
    const t = tools(live);
    answer = {
      status: 409,
      body: '{"ok":false,"error":"refused: agents are locked out at the device"}',
    };
    const r = await t.pixelbar_status!.handler({ status: "done" } as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("refused: agents are locked out at the device");
    answer = { status: 401, body: "nope" };
    const r2 = await t.pixelbar_clear!.handler({} as never);
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toContain("401");
    answer = { status: 200, body: '{"ok":true,"result":"ok"}' };
  });

  test("a bar that does not answer costs an error result, never a throw or a long wait", async () => {
    const t = tools({ enabled: true, url: "http://127.0.0.1:1", key: "KEY12345", timeout_ms: 300 });
    const began = Date.now();
    const r = await t.pixelbar_status!.handler({ status: "working" } as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("did not answer");
    expect(textOf(r)).toContain("Carry on without it");
    expect(Date.now() - began).toBeLessThan(2000);
  });

  test("without a key nothing is sent", async () => {
    const t = tools({ enabled: true, url: `http://localhost:${bar.port}`, key: "" });
    seen.length = 0;
    const r = await t.pixelbar_clear!.handler({} as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not set up");
    expect(seen).toEqual([]);
  });
});

describe("what the model may ask for", () => {
  const t = tools(live);
  const ok = (name: string, args: unknown) => t[name]!.inputSchema.safeParse(args).success;

  test("only real statuses, modes and scenes", () => {
    expect(ok("pixelbar_status", { status: "working" })).toBe(true);
    expect(ok("pixelbar_status", { status: "dancing" })).toBe(false);
    expect(ok("pixelbar_mode", { mode: "oasis" })).toBe(true);
    expect(ok("pixelbar_mode", { mode: "glow" })).toBe(false);
    expect(ok("pixelbar_mode", { mode: "scenes", scene: "disco" })).toBe(false);
  });

  test("a picture is exactly 8 rows of 32, and colours are hex", () => {
    const rows = Array(8).fill(".".repeat(32));
    expect(ok("pixelbar_draw", { rows, palette: { "#": "#d97757" } })).toBe(true);
    expect(ok("pixelbar_draw", { rows: rows.slice(1), palette: {} })).toBe(false);
    expect(ok("pixelbar_draw", { rows, palette: { "#": "orange" } })).toBe(false);
  });

  test("expiry and timers stay inside what the bar accepts", () => {
    expect(ok("pixelbar_text", { text: "HI", ttl_s: 3600 })).toBe(true);
    expect(ok("pixelbar_text", { text: "HI", ttl_s: 3601 })).toBe(false);
    expect(ok("pixelbar_text", { text: "" })).toBe(false);
    expect(ok("pixelbar_timer", { seconds: 86401 })).toBe(false);
    expect(ok("pixelbar_progress", { fraction: 1.5 })).toBe(false);
  });
});
