/**
 * Edmund changing his own voice during a call: only male American and British
 * Kokoro voices, for that call only, checked again where the voice is used.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallStore, callsDbPath } from "../src/calls/store.ts";
import type { CallRecord } from "../src/calls/types.ts";
import { ownVoices, voiceForCall } from "../src/calls/voice-settings.ts";
import type { Config } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { callTools } from "../src/mcp/tools/calls.ts";
import type { ToolDef } from "../src/mcp/tools/types.ts";
import { zodToJsonSchema } from "../src/mcp/zod-to-json.ts";
import { kokoroVoices } from "../src/voice/speech-sidecar.ts";

/** A sample of Kokoro's names: language letter, then gender. */
const INSTALLED = [
  "af_heart",
  "am_adam",
  "am_michael",
  "bf_emma",
  "bm_daniel",
  "bm_george",
  "em_alex",
  "hm_omega",
  "jm_kumo",
  "pm_santa",
  "zm_yunxi",
];
const SESSION = "imessage:dm:+15555550123";
const TUNED = { voice: "bm_daniel:0.7,am_michael:0.3", speed: 1.1 };

let dir = "";
let store: CallStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "call-voice-"));
  store = new CallStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(id: string, sessionKey = SESSION): CallRecord {
  const record: CallRecord = {
    id,
    provider: "FaceTime",
    direction: "inbound",
    conversation: { sessionKey, chatGuid: "", isGroup: false, label: "Dana", handles: [] },
    requestedBy: null,
    reason: null,
    startedAtMs: Date.now(),
    answeredAtMs: null,
    endedAtMs: null,
    endReason: null,
    handedOff: [],
  };
  store.createCall(record, null);
  store.markAnswered(id, Date.now());
  return record;
}

describe("the voices Edmund may choose", () => {
  test("are Kokoro's male American and British ones, nothing else", () => {
    expect(ownVoices(INSTALLED)).toEqual(["am_adam", "am_michael", "bm_daniel", "bm_george"]);
  });

  test("a choice is used only when it is one of them and installed; speed stays tuned", () => {
    expect(voiceForCall(TUNED, "am_adam", INSTALLED)).toEqual({ voice: "am_adam", speed: 1.1 });
    expect(voiceForCall(TUNED, null, INSTALLED)).toEqual(TUNED);
    for (const refused of ["af_heart", "bf_emma", "jm_kumo", "am_nobody"])
      expect(voiceForCall(TUNED, refused, INSTALLED)).toEqual(TUNED);
    // Kokoro could not say what it has.
    expect(voiceForCall(TUNED, "am_adam", null)).toEqual(TUNED);
  });
});

describe("Kokoro's voices file", () => {
  test("lists one voice per .npy entry, sorted; nothing when missing", () => {
    const src = join(dir, "npz");
    mkdirSync(src);
    for (const name of ["bm_george.npy", "af_heart.npy", "README"])
      writeFileSync(join(src, name), "x");
    const file = join(dir, "voices.bin");
    expect(
      spawnSync("zip", [
        "-q",
        "-j",
        file,
        ...["bm_george.npy", "af_heart.npy", "README"].map((n) => join(src, n)),
      ]).status,
    ).toBe(0);
    expect(kokoroVoices(file)).toEqual(["af_heart", "bm_george"]);
    expect(kokoroVoices(join(dir, "absent.bin"))).toEqual([]);
  });
});

describe("the call's voice in calls.db", () => {
  test("is held for that call only: an ended call takes none, the next call starts with none", () => {
    const first = call("call_1");
    expect(store.liveCall(SESSION)?.id).toBe(first.id);
    expect(store.setVoice(first.id, "am_adam")).toBe(true);
    expect(store.voice(first.id)).toBe("am_adam");
    store.markEnded(first.id, Date.now(), "hung up");
    expect(store.liveCall(SESSION)).toBeNull();
    expect(store.setVoice(first.id, "bm_george")).toBe(false);
    const second = call("call_2");
    expect(store.voice(second.id)).toBeNull();
  });

  test("a database from before the column gets it", () => {
    store.close();
    rmSync(callsDbPath(dir));
    const old = new Database(callsDbPath(dir));
    old.exec(`CREATE TABLE calls (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_call TEXT,
      direction TEXT NOT NULL, session_key TEXT NOT NULL, chat_guid TEXT NOT NULL,
      conversation TEXT NOT NULL, requested_by TEXT, reason TEXT, started_at INTEGER NOT NULL,
      answered_at INTEGER, ended_at INTEGER, end_reason TEXT, handed_off TEXT NOT NULL DEFAULT '[]')`);
    old.close();
    store = new CallStore(dir);
    const live = call("call_1");
    expect(store.setVoice(live.id, "bm_george")).toBe(true);
    expect(store.voice(live.id)).toBe("bm_george");
  });

  test("calls a killed daemon left open are ended at the next start", () => {
    call("call_1");
    expect(store.endUnfinished(Date.now(), "Edmund restarted")).toBe(1);
    expect(store.liveCall(SESSION)).toBeNull();
    expect(store.getCall("call_1")?.endReason).toBe("Edmund restarted");
    expect(store.endUnfinished(Date.now(), "Edmund restarted")).toBe(0);
  });
});

describe("call_voice", () => {
  const ctx = (sessionKey = SESSION) =>
    ({
      config: { facetime: { enabled: true } } as unknown as Config,
      sessionKey,
      dataDir: dir,
    }) as unknown as ToolContext;
  const tools = (installed = INSTALLED, sessionKey = SESSION) =>
    callTools(ctx(sessionKey), () => installed);
  const tool = (name: string, installed = INSTALLED): ToolDef => {
    const found = tools(installed).find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  const run = async (name: string, args: unknown) => {
    const t = tool(name);
    const result = await t.handler(t.inputSchema.parse(args));
    return {
      text: result.content.map((c) => ("text" in c ? c.text : "")).join(""),
      error: !!result.isError,
    };
  };

  test("offers exactly the allowed voices and usual, in the published schema", () => {
    const schema = zodToJsonSchema(tool("call_voice").inputSchema, "call_voice");
    expect(schema.properties.voice).toMatchObject({
      enum: ["usual", "am_adam", "am_michael", "bm_daniel", "bm_george"],
    });
    expect(tool("call_voice").inputSchema.safeParse({ voice: "af_heart" }).success).toBe(false);
    expect(tool("call_voice").inputSchema.safeParse({ voice: "jm_kumo" }).success).toBe(false);
  });

  test("is not offered when Kokoro has none of them", () => {
    expect(tools(["af_heart", "jm_kumo"]).map((t) => t.name)).not.toContain("call_voice");
    expect(tools([]).map((t) => t.name)).not.toContain("call_voice");
  });

  test("off a call, it says so and stores nothing", async () => {
    const ended = call("call_1");
    store.markEnded(ended.id, Date.now(), "hung up");
    expect(await run("call_voice", { voice: "am_adam" })).toEqual({
      text: "This conversation is not on a call.",
      error: true,
    });
    expect(store.voice(ended.id)).toBeNull();
  });

  test("on a call, it sets the voice for that call, and usual clears it", async () => {
    call("call_other", "imessage:dm:+15555550999");
    const live = call("call_1");
    const set = await run("call_voice", { voice: "bm_george" });
    expect(set.error).toBe(false);
    expect(set.text).toContain("bm_george");
    expect(store.voice(live.id)).toBe("bm_george");
    expect(store.voice("call_other")).toBeNull();
    expect((await run("call_status", {})).text).toContain("speaking as bm_george");
    await run("call_voice", { voice: "usual" });
    expect(store.voice(live.id)).toBeNull();
  });
});
