import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import { mountFor } from "../../../src/web/mounts.ts";
import { PrinterLink } from "../src/link.ts";
import { PrinterRuntime } from "../src/runtime.ts";
import { readRuntimeInfo } from "../src/settings.ts";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sources = () => [
  "tools.ts",
  "index.ts",
  ...readdirSync(join(root, "src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/${f}`),
];

describe("what can move the printer, structurally", () => {
  test("no file builds a pause command", () => {
    for (const f of sources()) {
      expect([f, /command:\s*"pause"/.test(read(f))]).toEqual([f, false]);
    }
  });

  test("the link refuses a pause from any caller, connected or not", async () => {
    const link = new PrinterLink({ host: "127.0.0.1", accessCode: "x", serial: "x" });
    await expect(link.command("print", { command: "pause", param: "" })).rejects.toThrow(
      "does not pause",
    );
  });

  test("print, cancel and resume are sent only by the daemon's runtime", () => {
    for (const f of sources()) {
      const s = read(f);
      const sendsPrint = /\.command\(\s*"print"/.test(s);
      expect([f, sendsPrint]).toEqual([f, f === "src/runtime.ts"]);
    }
    expect(read("src/runtime.ts")).toContain('command: "project_file"');
    // The tool side has a path to the runtime for these, and none of its own.
    expect(read("src/access.ts")).not.toContain('"print"');
  });

  test("the runtime checks the gate before every start and every control", () => {
    const s = read("src/runtime.ts");
    const start = s.slice(s.indexOf("async startJob("), s.indexOf("private autoWatches("));
    expect(start.indexOf("checkStartGate")).toBeGreaterThan(-1);
    expect(start.indexOf("checkStartGate")).toBeLessThan(start.indexOf('"project_file"'));
    const control = s.slice(s.indexOf("async control("), s.indexOf("/* ── HTTP"));
    expect(control.indexOf("checkControlGate")).toBeLessThan(control.indexOf(".command("));
  });
});

describe("slicer runs leave nothing behind", () => {
  test("every slicer call names where its result goes", () => {
    // The CLI writes result.json into its working directory when there is no
    // --outputdir: an export run from the daemon once left one in the repo root.
    const tools = read("tools.ts");
    const exportCall = tools.slice(
      tools.indexOf('"--export-stls"'),
      tools.indexOf('"--export-stls"') + 400,
    );
    expect(exportCall).toContain("cwd: partsDir");
    expect(read("src/slicer.ts")).toContain('"--outputdir"');
  });
});

describe("the runtime over its own HTTP surface", () => {
  const dir = mkdtempSync(join(tmpdir(), "printer-runtime-"));
  let rt: PrinterRuntime;
  let base = "";
  let secret = "";

  beforeAll(() => {
    const chat = join(dir, "chat.db");
    const db = new Database(chat);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, handle_id INTEGER, is_from_me INTEGER,
      date INTEGER, attributedBody BLOB, associated_message_guid TEXT, associated_message_type INTEGER);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT); CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);`);
    db.close();
    const config = {
      paths: { chat_db: chat, data_dir: dir },
      security: { operator_handles: ["+15555550100"] },
      alerts: { operator_handle: "" },
      owner: { name: "Alex Example" },
      shelf: { origin: "https://print.example.com" },
      claude: { model: "test-model", agent_model: "" },
      printer: { enabled: true, host: "127.0.0.1", access_code: "12345678", serial: "SERIAL" },
    } as unknown as Config;
    rt = new PrinterRuntime(config, { ...configPrinter(), host: "127.0.0.1" }, dir, () => {});
    rt.start();
    const info = readRuntimeInfo(dir)!;
    base = `http://127.0.0.1:${info.port}`;
    secret = info.secret;
  });
  afterAll(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = (p: string, body?: unknown, auth = true) =>
    fetch(`${base}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: auth ? { Authorization: `Bearer ${secret}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("the API answers only to the secret", async () => {
    expect((await api("/api/state", undefined, false)).status).toBe(403);
    expect((await api("/api/state")).status).toBe(200);
  });

  test("pause does not exist", async () => {
    const r = (await (await api("/api/control", { action: "pause", session: "s" })).json()) as {
      ok: boolean;
      message: string;
    };
    expect(r.ok).toBe(false);
    expect(r.message).toContain("does not pause");
  });

  test("a start with no approval is refused with its reasons", async () => {
    const job = rt.store.createJob({
      title: "Cube",
      requester: "Sam",
      requesterHandle: "",
      originSession: "imessage:dm:+15555550101",
      originChat: "",
      file: join(dir, "none.gcode.3mf"),
      source: "",
      plate: 1,
      plateType: "Textured PEI Plate",
      needs: [],
      estimateS: 60,
      weightG: 1,
      settings: {},
      preview: "",
    });
    const r = (await (
      await api("/api/start", { jobId: job.id, session: "imessage:dm:+15555550101", frameId: null })
    ).json()) as {
      ok: boolean;
      problems: string[];
    };
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("Nobody has been asked");
    expect(rt.store.job(job.id)?.status).toBe("draft");
  });

  test("a cancel with no yes is refused", async () => {
    const r = (await (await api("/api/control", { action: "cancel", session: "s" })).json()) as {
      ok: boolean;
      problems: string[];
    };
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("Nobody has been asked");
  });

  test("the page exists only for a real job past draft, behind its token", async () => {
    const job = rt.store.jobs({ limit: 1 })[0]!;
    expect((await fetch(`${base}/print/${job.token}/`)).status).toBe(404);
    rt.store.updateJob(job.id, { status: "awaiting_approval" });
    const page = await fetch(`${base}/print/${job.token}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Cube");
    expect((await fetch(`${base}/print/${"0".repeat(32)}/`)).status).toBe(404);
    expect((await fetch(`${base}/print/${job.token}/frame.jpg`)).status).toBe(404);
  });

  test("the public host is told where the page lives", () => {
    expect(mountFor(dir, "/print/abc/")).toBe(Number(new URL(base).port));
    expect(mountFor(dir, "/api/state")).toBeNull();
  });
});

function configPrinter() {
  return {
    enabled: true,
    host: "127.0.0.1",
    access_code: "12345678",
    serial: "SERIAL",
    name: "the printer",
    approvers: [],
    approver_name: "",
    plate: "textured_pei" as const,
    timelapse: true,
    slicer_path: "/nonexistent",
    page_origin: "",
    vision_model: "",
    approval_ttl_hours: 12,
    auto_progress: [25, 50, 75],
    camera_fps: 1,
  };
}
