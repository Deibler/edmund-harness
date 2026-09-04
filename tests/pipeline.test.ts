import { describe, expect, test } from "bun:test";
import { SessionPipeline } from "../src/channels/pipeline.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { SessionLocks } from "../src/sessions/locks.ts";

let rowId = 1;
function msg(text: string, attachments: string[] = []): InboundMessage {
  return {
    rowId: rowId++,
    msgGuid: `guid-${rowId}`,
    chatIdentifier: "+15550000000",
    chatGuid: "iMessage;-;+15550000000",
    isGroup: false,
    fromHandle: "+15550000000",
    fromMe: false,
    text,
    timestampMs: Date.now(),
    attachments,
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("SessionPipeline", () => {
  test("messages within the idle window flush as one batch", async () => {
    const batches: InboundMessage[][] = [];
    const p = new SessionPipeline({
      debounceMs: 40,
      handler: async (_k, b) => {
        batches.push(b);
      },
      locks: new SessionLocks(),
    });
    p.enqueue("k", msg("a"));
    await sleep(10);
    p.enqueue("k", msg("b"));
    await sleep(10);
    p.enqueue("k", msg("c"));
    await sleep(80);
    expect(batches.length).toBe(1);
    expect(batches[0]!.map((m) => m.text)).toEqual(["a", "b", "c"]);
  });

  test("the burst cap forces a flush even if messages keep coming", async () => {
    const batches: InboundMessage[][] = [];
    const p = new SessionPipeline({
      debounceMs: 1000, // idle window longer than the cap on purpose
      maxMs: 60,
      handler: async (_k, b) => {
        batches.push(b);
      },
      locks: new SessionLocks(),
    });
    for (let i = 0; i < 10; i++) {
      p.enqueue("k", msg(`m${i}`));
      await sleep(15);
    }
    await sleep(50);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    // Everything that arrived before the cap fired lands in the first batch.
    expect(batches[0]!.length).toBeGreaterThanOrEqual(2);
  });

  test("a message arriving mid-turn joins the next batch, not a new turn", async () => {
    const batches: InboundMessage[][] = [];
    let started = 0;
    const p = new SessionPipeline({
      debounceMs: 20,
      handler: async (_k, b) => {
        started++;
        batches.push(b);
        await sleep(60); // hold the turn open
      },
      locks: new SessionLocks(),
    });
    p.enqueue("k", msg("first"));
    await sleep(35); // let the first turn start
    expect(started).toBe(1);
    p.enqueue("k", msg("second")); // arrives while the first turn is running
    p.enqueue("k", msg("third"));
    await sleep(150);
    expect(batches.length).toBe(2);
    expect(batches[0]!.map((m) => m.text)).toEqual(["first"]);
    expect(batches[1]!.map((m) => m.text)).toEqual(["second", "third"]);
  });

  test("a captioned attachment uses the short window", async () => {
    const flushedAt: number[] = [];
    const t0 = Date.now();
    const p = new SessionPipeline({
      debounceMs: 1000,
      captionedAttachmentMs: 30,
      bareAttachmentMs: 5000,
      handler: async () => {
        flushedAt.push(Date.now() - t0);
      },
      locks: new SessionLocks(),
    });
    p.enqueue("k", msg("check this out", ["/tmp/photo.jpg"]));
    await sleep(120);
    expect(flushedAt.length).toBe(1);
    expect(flushedAt[0]!).toBeLessThan(200); // not the 1000ms / 5000ms windows
  });

  test("a bare attachment waits the long window, and a follow-up text batches with it", async () => {
    const batches: InboundMessage[][] = [];
    const p = new SessionPipeline({
      debounceMs: 30,
      captionedAttachmentMs: 20,
      bareAttachmentMs: 120,
      maxMs: 5000,
      handler: async (_k, b) => {
        batches.push(b);
      },
      locks: new SessionLocks(),
    });
    p.enqueue("k", msg("", ["/tmp/photo.jpg"])); // bare photo, no text
    await sleep(60); // less than the 120ms bare window — nothing yet
    expect(batches.length).toBe(0);
    p.enqueue("k", msg("what do you think?")); // the caption, a beat later
    await sleep(200);
    expect(batches.length).toBe(1);
    expect(batches[0]!.map((m) => m.text)).toEqual(["", "what do you think?"]);
  });

  describe("voice sessions", () => {
    // The mic's VAD already endpointed the utterance, so the typing debounce
    // is pure dead air between the speaker stopping and the model starting.
    test("a spoken turn flushes on the short voice window, not the typing one", async () => {
      const batches: InboundMessage[][] = [];
      const p = new SessionPipeline({
        debounceMs: 400,
        voiceDebounceMs: 40,
        handler: async (_k, b) => {
          batches.push(b);
        },
        locks: new SessionLocks(),
      });
      p.enqueue("mirror:pi-4", msg("what's the weather"));
      await sleep(120); // past the voice window, far short of the typing one
      expect(batches.length).toBe(1);
      expect(batches[0]!.map((m) => m.text)).toEqual(["what's the weather"]);
    });

    test("typing sessions keep the long window", async () => {
      const batches: InboundMessage[][] = [];
      const p = new SessionPipeline({
        debounceMs: 400,
        voiceDebounceMs: 40,
        handler: async (_k, b) => {
          batches.push(b);
        },
        locks: new SessionLocks(),
      });
      p.enqueue("dm:+15550000000", msg("hey"));
      await sleep(120);
      expect(batches.length).toBe(0); // still batching, as it should
      await sleep(400);
      expect(batches.length).toBe(1);
    });

    test("two utterances landing together still fold into one turn", async () => {
      const batches: InboundMessage[][] = [];
      const p = new SessionPipeline({
        debounceMs: 400,
        voiceDebounceMs: 60,
        handler: async (_k, b) => {
          batches.push(b);
        },
        locks: new SessionLocks(),
      });
      p.enqueue("mirror:pi-4", msg("actually wait"));
      await sleep(20);
      p.enqueue("mirror:pi-4", msg("make that tomorrow"));
      await sleep(200);
      expect(batches.length).toBe(1);
      expect(batches[0]!.map((m) => m.text)).toEqual(["actually wait", "make that tomorrow"]);
    });

    test("a voice message carrying an attachment keeps the attachment window", async () => {
      const batches: InboundMessage[][] = [];
      const p = new SessionPipeline({
        debounceMs: 400,
        voiceDebounceMs: 40,
        bareAttachmentMs: 200,
        handler: async (_k, b) => {
          batches.push(b);
        },
        locks: new SessionLocks(),
      });
      p.enqueue("mirror:pi-4", msg("", ["/tmp/photo.jpg"]));
      await sleep(100); // past the voice window; the bare-attachment grace still applies
      expect(batches.length).toBe(0);
      await sleep(250);
      expect(batches.length).toBe(1);
    });
  });
});
