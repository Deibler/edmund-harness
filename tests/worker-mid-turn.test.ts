/**
 * A message that arrives while a turn runs is written to the running worker,
 * and the model sees it at its next tool step (mid-turn.ts). The fake CLI
 * reproduces what CLI 2.1.309 did on 2026-10-25: a message written during a
 * tool call is echoed when the tool returns and joins the turn; one that
 * misses the turn becomes a turn of its own after the result.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { midTurnNote, showToRunningTurn, takeSeenMidTurn } from "../src/claude/mid-turn.ts";
import { Worker } from "../src/claude/worker.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

const bin = mkdtempSync(join(tmpdir(), "fake-claude-midturn-"));
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures/fake-claude-midturn.ts")}" "$@"\n`,
);
chmodSync(join(bin, "claude"), 0o755);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

const user = (text: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

let n = 0;
function worker(extra: string[] = [], env: Record<string, string> = {}) {
  const sessionKey = `test:midturn:${++n}`;
  const w = new Worker({
    argv: [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--replay-user-messages",
      ...extra,
    ],
    env: { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}`, ...env },
    cwd: bin,
    perTurnIdleMs: 5_000,
    sessionKey,
  });
  return { w, sessionKey };
}

/** Start a turn and resolve once its tool call is in flight. */
function turnWithTool(w: Worker, text: string) {
  let toolStarted: () => void = () => {};
  const started = new Promise<void>((r) => {
    toolStarted = r;
  });
  const done = w.turn({
    stdinPayload: user(text),
    onActivity: (a) => {
      if (a === "working") toolStarted();
    },
  });
  return { started, done };
}

describe("a message written to a running turn", () => {
  test("joins the turn at the next tool step and is reported as seen", async () => {
    const { w, sessionKey } = worker();
    try {
      const { started, done } = turnWithTool(w, "the long job");
      await started;
      const shown = w.inject("Sam: what time is the game?");
      expect(shown.ok).toBe(true);
      const r = await done;
      expect(r.ok).toBe(true);
      if (!r.ok || !shown.ok) return;
      expect(r.reply).toBe("done; saw: Sam: what time is the game?");
      expect(r.seenMidTurn).toEqual([shown.uuid]);
      expect([...takeSeenMidTurn(sessionKey)]).toEqual([shown.uuid]);
      expect(takeSeenMidTurn(sessionKey).size).toBe(0);
      // The worker carries on as usual.
      const next = await w.turn({ stdinPayload: user("again") });
      expect(next.ok && next.reply).toBe("done: again");
    } finally {
      await w.shutdown("test done");
    }
  });

  test("is refused while no tool step is in flight", async () => {
    const { w } = worker();
    try {
      const done = w.turn({ stdinPayload: user("notool") });
      // The turn is pending but no tool has started: the model may be writing
      // its final reply, and a message now would become a turn of its own.
      expect(w.inject("too late")).toEqual({ ok: false, reason: "no tool step in flight" });
      const r = await done;
      expect(r.ok && r.reply).toBe("no tool");
      expect(r.ok && r.seenMidTurn).toEqual([]);
      expect(w.inject("between turns")).toEqual({ ok: false, reason: "no turn running" });
    } finally {
      await w.shutdown("test done");
    }
  });

  test("is refused once the tool step has returned and the reply is being written", async () => {
    const { w } = worker([], { FAKE_FINAL_MS: "300" });
    try {
      let phase = "";
      let toolReturned: () => void = () => {};
      const returned = new Promise<void>((r) => {
        toolReturned = r;
      });
      const done = w.turn({
        stdinPayload: user("the long job"),
        onActivity: (a) => {
          if (phase === "working" && a === "thinking") toolReturned();
          phase = a;
        },
      });
      await returned;
      expect(w.inject("Sam: hello?")).toEqual({ ok: false, reason: "no tool step in flight" });
      const r = await done;
      expect(r.ok && r.reply).toBe("done: the long job");
      expect(w.isDead).toBe(false);
    } finally {
      await w.shutdown("test done");
    }
  });

  test("one that misses the turn retires the worker before its own turn can be mistaken for the next", async () => {
    const { w, sessionKey } = worker(["--late"]);
    try {
      const { started, done } = turnWithTool(w, "the long job");
      await started;
      expect(w.inject("Sam: still there?").ok).toBe(true);
      const r = await done;
      expect(r.ok && r.reply).toBe("done: the long job");
      expect(r.ok && r.seenMidTurn).toEqual([]);
      expect(takeSeenMidTurn(sessionKey).size).toBe(0);
      await Bun.sleep(50);
      expect(w.isDead).toBe(true);
      // Kept alive, the next turn would have been handed "late: Sam: still there?".
      const next = await w.turn({ stdinPayload: user("the next message") });
      expect(next.ok).toBe(false);
    } finally {
      await w.shutdown("test done");
    }
  });
});

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  rowId: 7,
  msgGuid: "GUID-7",
  chatIdentifier: "chat5550100",
  chatGuid: "any;+;chat5550100",
  isGroup: true,
  fromHandle: "+15550100021",
  fromMe: false,
  text: "edmund what time is the game",
  timestampMs: Date.UTC(2026, 9, 25, 19, 4),
  attachments: [],
  attachmentTranscripts: {},
  service: "iMessage",
  replyToGuid: null,
  ...over,
});

describe("the note the turn is shown", () => {
  test("names the sender and the message, and says how to answer", () => {
    const note = midTurnNote(msg(), "Riley", true)!;
    expect(note).toStartWith("[SYSTEM — a new message arrived while you're working]");
    expect(note).toContain("Riley · Sun 2026-10-25 15:04 EDT:");
    expect(note).toContain("edmund what time is the game");
    expect(note).toContain("(message id GUID-7)");
    expect(note).toContain("send_message");
    expect(note).toContain("someone other than whoever asked for your current task");
    expect(midTurnNote(msg({ isGroup: false }), "Riley", false)).not.toContain(
      "someone other than",
    );
  });

  test("a voice note goes as its transcript; a photo waits for the end of the turn", () => {
    const voice = midTurnNote(
      msg({
        text: "",
        attachments: ["/a/v.caf"],
        attachmentTranscripts: { "/a/v.caf": "running late" },
      }),
      "Riley",
      true,
    );
    expect(voice).toContain("(voice note) running late");
    expect(midTurnNote(msg({ attachments: ["/a/p.heic"] }), "Riley", true)).toBeNull();
    expect(midTurnNote(msg({ text: "  " }), "Riley", true)).toBeNull();
  });

  test("showing reports the uuid, or null when the turn could not take it", () => {
    const seen: string[] = [];
    const deps = {
      label: () => "Riley",
      inject: (_k: string, text: string) => {
        seen.push(text);
        return { ok: true as const, uuid: "u-1" };
      },
    };
    expect(showToRunningTurn("imessage:group:any;+;chat5550100", msg(), deps)).toBe("u-1");
    expect(seen[0]).toContain("Riley ·");
    const refused = {
      ...deps,
      inject: () => ({ ok: false as const, reason: "no tool step in flight" }),
    };
    expect(showToRunningTurn("imessage:group:any;+;chat5550100", msg(), refused)).toBeNull();
    const throws = {
      ...deps,
      inject: () => {
        throw new Error("boom");
      },
    };
    expect(showToRunningTurn("imessage:group:any;+;chat5550100", msg(), throws)).toBeNull();
  });
});
