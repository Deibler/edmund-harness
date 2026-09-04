import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPending,
  drainPending,
  entryToInbound,
  parsePendingLine,
  peekPending,
  pendingToInbound,
  toPendingEntry,
  writePending,
} from "../src/bridge/session-queue.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

const KEY = "imessage:dm:+15550001111";
let dir: string;

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    rowId: 100,
    msgGuid: "GUID-100",
    chatIdentifier: "+15550001111",
    chatGuid: "iMessage;-;+15550001111",
    isGroup: false,
    fromHandle: "+15550001111",
    fromMe: false,
    text: "hello",
    timestampMs: 1_700_000_000_000,
    attachments: ["/tmp/voice.caf"],
    attachmentTranscripts: { "/tmp/voice.caf": "hey can you help" },
    service: "iMessage",
    replyToGuid: "GUID-99",
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-pending-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session-queue", () => {
  test("round-trips every InboundMessage field through the queue", () => {
    const msg = inbound();
    writePending(KEY, msg, dir);
    const [e] = drainPending(KEY, dir);
    expect(e).toBeDefined();
    expect(e!.msgGuid).toBe("GUID-100");
    expect(e!.attachmentTranscripts).toEqual({ "/tmp/voice.caf": "hey can you help" });
    expect(e!.replyToGuid).toBe("GUID-99");
    expect(e!.service).toBe("iMessage");
    expect(e!.chatGuid).toBe("iMessage;-;+15550001111");

    const ref = inbound({ rowId: 1, msgGuid: "REF" });
    const reconstructed = pendingToInbound(e!, ref);
    expect(reconstructed.msgGuid).toBe("GUID-100");
    expect(reconstructed.attachmentTranscripts).toEqual({ "/tmp/voice.caf": "hey can you help" });
    expect(reconstructed.replyToGuid).toBe("GUID-99");
    expect(reconstructed.fromMe).toBe(false);
  });

  test("drain clears the queue; peek does not", () => {
    writePending(KEY, inbound(), dir);
    expect(peekPending(KEY, dir)).toHaveLength(1);
    expect(peekPending(KEY, dir)).toHaveLength(1); // still there
    expect(drainPending(KEY, dir)).toHaveLength(1);
    expect(peekPending(KEY, dir)).toHaveLength(0); // gone
  });

  test("dedupes by rowId", () => {
    const m = inbound();
    writePending(KEY, m, dir);
    writePending(KEY, m, dir);
    expect(drainPending(KEY, dir)).toHaveLength(1);
  });

  test("backfills defaults for legacy entries missing the newer fields", () => {
    // A real write creates the pending dir + file with a deterministic name.
    writePending(KEY, inbound({ rowId: 1 }), dir);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const file = join(dir, "pending", readdirSync(join(dir, "pending"))[0]!);
    // Append a line shaped like an older build wrote it (original 5 fields only).
    const legacy = {
      rowId: 7,
      text: "old message",
      fromHandle: "+15550009999",
      timestampMs: 1_699_999_999_000,
      attachments: [],
    };
    appendFileSync(file, `${JSON.stringify(legacy)}\n`);

    const entries = drainPending(KEY, dir);
    const old = entries.find((x) => x.rowId === 7)!;
    expect(old).toBeDefined();
    expect(old.msgGuid).toBe("");
    expect(old.attachmentTranscripts).toEqual({});
    expect(old.replyToGuid).toBeNull();
    expect(old.service).toBe("iMessage");
    expect(old.isGroup).toBe(false);

    // pendingToInbound falls back to the ref for the chat id / group flag a
    // legacy entry never persisted (service defaults to iMessage either way).
    const ref = inbound({ chatGuid: "iMessage;-;chat999", isGroup: true });
    const rec = pendingToInbound(old, ref);
    expect(rec.chatGuid).toBe("iMessage;-;chat999");
    expect(rec.isGroup).toBe(true);
  });

  test("toPendingEntry serializes a full message", () => {
    const msg = inbound({ rowId: 42, msgGuid: "G-42", text: "hi" });
    const e = toPendingEntry(msg);
    expect(e.rowId).toBe(42);
    expect(e.msgGuid).toBe("G-42");
    expect(e.text).toBe("hi");
    expect(e.attachments).toEqual(["/tmp/voice.caf"]);
    expect(e.attachmentTranscripts).toEqual({ "/tmp/voice.caf": "hey can you help" });
  });

  test("parsePendingLine / entryToInbound round-trip", () => {
    const msg = inbound({ rowId: 50, text: "round trip" });
    const json = JSON.stringify(toPendingEntry(msg));
    const parsed = parsePendingLine(json)!;
    expect(parsed).toBeDefined();
    expect(parsed.rowId).toBe(50);
    expect(parsed.text).toBe("round trip");

    const rebuilt = entryToInbound(parsed)!;
    expect(rebuilt).toBeDefined();
    expect(rebuilt.rowId).toBe(50);
    expect(rebuilt.chatGuid).toBe(msg.chatGuid);
    expect(rebuilt.chatIdentifier).toBe(msg.chatIdentifier);
  });

  test("entryToInbound returns null for entries missing chat fields", () => {
    expect(
      entryToInbound({
        rowId: 1,
        msgGuid: "",
        text: null,
        fromHandle: "",
        timestampMs: 0,
        attachments: [],
        attachmentTranscripts: {},
        replyToGuid: null,
        service: "",
        chatIdentifier: "",
        chatGuid: "",
        isGroup: false,
      }),
    ).toBeNull();
    expect(
      entryToInbound({
        rowId: 1,
        msgGuid: "",
        text: null,
        fromHandle: "",
        timestampMs: 0,
        attachments: [],
        attachmentTranscripts: {},
        replyToGuid: null,
        service: "",
        chatIdentifier: "",
        chatGuid: "g",
        isGroup: false,
      }),
    ).toBeNull();
  });

  test("parsePendingLine returns null on garbage", () => {
    expect(parsePendingLine("not json")).toBeNull();
    expect(parsePendingLine('{"rowId":"not a number"}')).toBeNull();
  });
});
