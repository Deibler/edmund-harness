import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchHandler } from "../src/channels/pipeline.ts";
import { ExchangeLog } from "../src/grok/exchanges.ts";
import { GrokRelay, trackGrokTurns } from "../src/grok/relay.ts";
import {
  GROK_REPORT_SERVICE,
  GROK_SERVICE,
  GROK_TELL_SERVICE,
  grokTurnOf,
  isGrokAsyncInbound,
  isGrokInbound,
} from "../src/grok/session.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { dmKeyFor, sessionKeyFor } from "../src/sessions/key.ts";

const HANDLE = "+15550100001";
const DM_KEY = dmKeyFor(HANDLE);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Pending = { key: string; msg: InboundMessage };

function text(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    rowId: 4_812_000,
    msgGuid: "imsg-1",
    chatIdentifier: HANDLE,
    chatGuid: `any;-;${HANDLE}`,
    isGroup: false,
    fromHandle: HANDLE,
    fromMe: false,
    text: "an ordinary text",
    timestampMs: Date.now(),
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

/** A relay whose "pipeline" is a hand-driven turn, and the wrapper around it. */
function rig(
  opts: {
    answerTimeoutMs?: number;
    canon?: (h: string) => string;
    chatGuidFor?: (k: string) => string | undefined;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "grok-relay-"));
  dirs.push(dir);
  const exchanges = new ExchangeLog(dir);
  const queue: Pending[] = [];
  const relay = new GrokRelay({
    handle: HANDLE,
    contacts: { canon: opts.canon ?? ((h) => h) },
    chatGuidFor: opts.chatGuidFor,
    enqueue: (key, msg) => queue.push({ key, msg }),
    exchanges,
    answerTimeoutMs: opts.answerTimeoutMs ?? 2_000,
    slowReply: "working on it",
    maxReplyChars: 200,
  });
  /**
   * What the pipeline does with a batch: run `body` as the turn. `body` gets the
   * guids a real turn would hand to `deliverReply`, so a test captures a reply
   * the way `turn.ts` does. `extra` are other messages that landed in the batch.
   */
  const runTurn = async (
    body: (guids: string[], batch: InboundMessage[]) => Promise<void> | void,
    which = 0,
    extra: InboundMessage[] = [],
  ): Promise<void> => {
    const { key, msg } = queue[which]!;
    const batch = [msg, ...extra];
    const handler: BatchHandler = async (_k, b) => {
      await body(grokTurnOf(b)?.msgGuids ?? [], b);
    };
    await trackGrokTurns(handler, () => relay)(key, batch);
  };
  return { relay, exchanges, queue, runTurn };
}

describe("GrokRelay", () => {
  test("enqueues the request in the person's own DM session and returns the captured reply", async () => {
    const { relay, queue, runTurn, exchanges } = rig();
    const answer = relay.ask("what's 2+2");
    expect(queue).toHaveLength(1);
    // The key an iMessage from them gets, not a session of its own.
    expect(queue[0]!.key).toBe(DM_KEY);
    expect(queue[0]!.key).toBe(sessionKeyFor(text()));
    expect(queue[0]!.key.startsWith("grok:")).toBe(false);
    expect(queue[0]!.msg).toMatchObject({
      text: "what's 2+2",
      fromHandle: HANDLE,
      service: GROK_SERVICE,
      isGroup: false,
      // The DM's real chat guid, so the session row never holds a synthetic one.
      chatGuid: `any;-;${HANDLE}`,
    });
    expect(isGrokInbound(queue[0]!.msg)).toBe(true);

    await runTurn((guids) => {
      expect(relay.capture("Four.", guids)).toEqual({ spoken: true, textToo: false });
    });

    expect(await answer).toBe("Four.");
    const logged = exchanges.since(0, 10);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ said: "what's 2+2", reply: "Four.", via: "spoken" });
  });

  test("the request's row id is negative, so it can never clear a real text's ack", () => {
    const { relay, queue } = rig();
    void relay.ask("one");
    void relay.ask("two");
    const [a, b] = queue.map((q) => q.msg.rowId);
    expect(a!).toBeLessThan(0);
    expect(b!).toBeLessThan(0);
    expect(a).not.toBe(b);
  });

  test("it keys the DM the way an iMessage would, canonical handle included", () => {
    const { relay, queue } = rig({ canon: () => "+15550109999" });
    void relay.ask("hi");
    expect(queue[0]!.key).toBe("imessage:dm:+15550109999");
  });

  test("it reuses the chat guid the DM session already has", () => {
    const seen: string[] = [];
    const { relay, queue } = rig({
      chatGuidFor: (k) => {
        seen.push(k);
        return "iMessage;-;+15550100001";
      },
    });
    void relay.ask("hi");
    expect(seen).toEqual([DM_KEY]);
    expect(queue[0]!.msg.chatGuid).toBe("iMessage;-;+15550100001");
  });

  test("a tool-only turn answers 'Done.'", async () => {
    const { relay, runTurn } = rig();
    const answer = relay.ask("text mom I'm on my way");
    await runTurn(() => {});
    expect(await answer).toBe("Done.");
  });

  test("a failed turn says so instead of 'Done.'", async () => {
    const { relay, runTurn } = rig();
    const answer = relay.ask("hello");
    await runTurn(() => {
      throw new Error("model fell over");
    }).catch(() => {});
    expect(await answer).toContain("snag");
  });

  test("past the timeout it returns the slow reply, and the late reply is not captured", async () => {
    const { relay, runTurn, exchanges } = rig({ answerTimeoutMs: 30 });
    const answer = relay.ask("research flights to Lisbon");

    let taken: unknown = null;
    const turn = runTurn(async (guids) => {
      await new Promise((r) => setTimeout(r, 80));
      // The line has given up: nothing is spoken, so deliverReply texts it.
      taken = relay.capture("Found three options, texting them now.", guids);
    });

    expect(await answer).toBe("working on it");
    await turn;
    // Nobody on the line, and the request that gave up is owed a text.
    expect(taken).toEqual({ spoken: false, textToo: true });

    const logged = exchanges.since(0, 10);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      said: "research flights to Lisbon",
      reply: "Found three options, texting them now.",
      via: "texted",
    });
  });

  test("a busy DM session: the request waits behind a running turn, times out, and its late reply is texted", async () => {
    const { relay, queue, exchanges } = rig({ answerTimeoutMs: 30 });
    const answer = relay.ask("what's on my calendar");

    // The session lock is held by another turn, so nothing for this request
    // runs. The line gives up first and says so.
    expect(await answer).toBe("working on it");
    expect(exchanges.since(0, 10)).toHaveLength(0);

    // The lock frees and the request's own turn finally runs.
    let taken: unknown = null;
    const { key, msg } = queue[0]!;
    await trackGrokTurns(
      async (_k, b) => {
        taken = relay.capture("Two meetings, the first at nine.", grokTurnOf(b)!.msgGuids);
      },
      () => relay,
    )(key, [msg]);

    expect(taken).toEqual({ spoken: false, textToo: true });
    const logged = exchanges.since(0, 10);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ reply: "Two meetings, the first at nine.", via: "texted" });
  });

  test("a reply that lands just before the timeout still beats 'working on it'", async () => {
    const { relay, runTurn } = rig({ answerTimeoutMs: 30 });
    const answer = relay.ask("quick one");
    const turn = runTurn(async (guids) => {
      relay.capture("Here you go.", guids);
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(await answer).toBe("Here you go.");
    await turn;
  });

  test("a reply for a batch with no Grok request (a reminder fire, a text) is not captured", () => {
    const { relay } = rig();
    void relay.ask("pending request");
    // A turn with no request in its batch passes no guids; one with other guids
    // names a request that is not waiting. Neither takes anything.
    expect(relay.capture("Time to leave.", [])).toEqual({ spoken: false, textToo: false });
    expect(relay.capture("Time to leave.", ["somebody-else"])).toEqual({
      spoken: false,
      textToo: false,
    });
  });

  test("a second request's turn does not take the first's late reply", async () => {
    const { relay, queue, runTurn } = rig({ answerTimeoutMs: 30 });
    const first = relay.ask("slow job");
    const second = relay.ask("quick question");
    expect(queue).toHaveLength(2);

    const firstTurn = runTurn(async (guids) => {
      await new Promise((r) => setTimeout(r, 80));
      expect(relay.capture("slow job result", guids).spoken).toBe(false);
    }, 0);
    expect(await first).toBe("working on it");
    await firstTurn;

    const secondTurn = runTurn((guids) => {
      relay.capture("quick answer", guids);
    }, 1);
    expect(await second).toBe("working on it"); // it timed out waiting behind the first
    await secondTurn;
  });

  test("two requests batched into one turn both hear its one reply", async () => {
    const { relay, queue, exchanges } = rig();
    const a = relay.ask("what time is it");
    const b = relay.ask("and the date");
    const batch = queue.map((q) => q.msg);
    await trackGrokTurns(
      async (_k, bt) => {
        relay.capture("Ten past four, the sixth.", grokTurnOf(bt)!.msgGuids);
      },
      () => relay,
    )(DM_KEY, batch);
    expect(await a).toBe("Ten past four, the sixth.");
    expect(await b).toBe("Ten past four, the sixth.");
    expect(exchanges.since(0, 10)).toHaveLength(2);
  });

  test("a request that already gave up and one still waiting: spoken to the one, texted for the other", async () => {
    const { relay, queue, exchanges } = rig({ answerTimeoutMs: 30 });
    const early = relay.ask("first, from a bot that gave up");
    expect(await early).toBe("working on it");
    const late = relay.ask("second, still on the line");
    await trackGrokTurns(
      async (_k, bt) => {
        const taken = relay.capture("Both done.", grokTurnOf(bt)!.msgGuids);
        // The abandoned one was promised a text, so the reply must reach iMessage too.
        expect(taken).toEqual({ spoken: true, textToo: true });
      },
      () => relay,
    )(
      DM_KEY,
      queue.map((q) => q.msg),
    );
    expect(await late).toBe("Both done.");
    const via = exchanges
      .since(0, 10)
      .map((e) => e.via)
      .sort();
    expect(via).toEqual(["spoken", "texted"]);
  });

  test("a long reply is cut for the voice", async () => {
    const { relay, runTurn } = rig();
    const answer = relay.ask("tell me everything");
    await runTurn((guids) => {
      relay.capture(`${"Sentence number one is here. ".repeat(20)}`, guids);
    });
    const out = await answer;
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".")).toBe(true);
  });

  test("a mixed batch (a real text and a request): the request still hears the reply", async () => {
    const { relay, runTurn } = rig();
    const answer = relay.ask("quick one");
    await runTurn(
      (guids, batch) => {
        expect(batch).toHaveLength(2);
        expect(grokTurnOf(batch)).toEqual({ msgGuids: guids, spoken: true, alsoText: true });
        relay.capture("On it.", guids);
      },
      0,
      [text()],
    );
    expect(await answer).toBe("On it.");
  });
});

describe("grokTurnOf", () => {
  const grok = (guid: string): InboundMessage => text({ msgGuid: guid, service: GROK_SERVICE });

  test("a batch of ordinary texts is no Grok turn at all", () => {
    expect(grokTurnOf([text(), text({ msgGuid: "imsg-2" })])).toBeUndefined();
    expect(grokTurnOf([])).toBeUndefined();
  });

  test("requests alone are spoken only", () => {
    expect(grokTurnOf([grok("g1"), grok("g2")])).toEqual({
      msgGuids: ["g1", "g2"],
      spoken: true,
      alsoText: false,
    });
  });

  test("requests beside a real text are spoken and texted", () => {
    expect(grokTurnOf([text(), grok("g1")])).toEqual({
      msgGuids: ["g1"],
      spoken: true,
      alsoText: true,
    });
    expect(grokTurnOf([grok("g1"), text()])).toEqual({
      msgGuids: ["g1"],
      spoken: true,
      alsoText: true,
    });
  });

  test("tells and reports are connector messages nobody is waiting on", () => {
    const tell = text({ msgGuid: "t1", service: GROK_TELL_SERVICE });
    const report = text({ msgGuid: "r1", service: GROK_REPORT_SERVICE });
    expect(grokTurnOf([tell, report])).toEqual({
      msgGuids: ["t1", "r1"],
      spoken: false,
      alsoText: false,
    });
    expect(grokTurnOf([tell, grok("g1")])?.spoken).toBe(true);
    expect(grokTurnOf([report, text()])).toEqual({
      msgGuids: ["r1"],
      spoken: false,
      alsoText: true,
    });
  });
});

describe("trackGrokTurns", () => {
  test("passes a batch of ordinary texts straight through, relay unconsulted", async () => {
    const calls: string[] = [];
    const wrapped = trackGrokTurns(
      async (key) => {
        calls.push(key);
      },
      () => {
        throw new Error("relay must not be consulted for a batch with no request");
      },
    );
    // The very session the requests share: it is the batch that decides.
    await wrapped(DM_KEY, [text()]);
    await wrapped("imessage:dm:+15550100002", []);
    expect(calls).toEqual([DM_KEY, "imessage:dm:+15550100002"]);
  });

  test("a turn that ends settles only its own requests", async () => {
    const { relay, queue } = rig();
    const a = relay.ask("first");
    const b = relay.ask("second");
    // Run the second request's turn alone.
    await trackGrokTurns(
      async (_k, bt) => {
        relay.capture("Second answer.", grokTurnOf(bt)!.msgGuids);
      },
      () => relay,
    )(DM_KEY, [queue[1]!.msg]);
    expect(await b).toBe("Second answer.");
    // The first is still waiting on its own turn, unharmed.
    const raced = await Promise.race([a, new Promise((r) => setTimeout(() => r("pending"), 30))]);
    expect(raced).toBe("pending");
    await trackGrokTurns(
      async (_k, bt) => {
        relay.capture("First answer.", grokTurnOf(bt)!.msgGuids);
      },
      () => relay,
    )(DM_KEY, [queue[0]!.msg]);
    expect(await a).toBe("First answer.");
  });
});

describe("tell and report: nobody on the line", () => {
  test("tell queues an inbound with the tell service and returns at once", () => {
    const { relay, queue } = rig();
    relay.tell("text my sister I'm running late");
    expect(queue).toHaveLength(1);
    const { key, msg } = queue[0]!;
    expect(key).toBe(DM_KEY);
    expect(msg.service).toBe(GROK_TELL_SERVICE);
    expect(isGrokAsyncInbound(msg)).toBe(true);
    expect(isGrokInbound(msg)).toBe(false);
    expect(msg.text).toBe("text my sister I'm running late");
    expect(msg.rowId).toBeLessThan(0);
    expect(msg.chatGuid).toBe(`any;-;${HANDLE}`);
  });

  test("report queues an inbound with the report service and the text given", () => {
    const { relay, queue } = rig();
    relay.report("Grok Bot finished task gb-1. Here is the result.", "Grok Bot finished task gb-1");
    const { msg } = queue[0]!;
    expect(msg.service).toBe(GROK_REPORT_SERVICE);
    expect(msg.text).toBe("Grok Bot finished task gb-1. Here is the result.");
  });

  test("the reply to a tell is texted, never spoken, and is logged with its kind", async () => {
    const { relay, exchanges, runTurn } = rig();
    relay.tell("book the dentist");
    let taken: { spoken: boolean; textToo: boolean } | undefined;
    await runTurn((guids) => {
      taken = relay.capture("Booked for Tuesday at ten.", guids);
    });
    expect(taken).toEqual({ spoken: false, textToo: true });
    const logged = exchanges.since(0, 10);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      said: "book the dentist",
      reply: "Booked for Tuesday at ten.",
      via: "texted",
      kind: "tell",
    });
  });

  test("a tell that ends with no reply (KEEP_QUIET) is still logged, with an empty reply", async () => {
    const { relay, exchanges, runTurn } = rig();
    relay.tell("connector test, no reply needed, reply KEEP_QUIET");
    await runTurn(() => {});
    expect(exchanges.since(0, 10)).toMatchObject([{ reply: "", via: "texted", kind: "tell" }]);
  });

  test("a report is logged as a report", async () => {
    const { relay, exchanges, runTurn } = rig();
    relay.report("Grok Bot finished task gb-9. Here is the result.", "Grok Bot finished task gb-9");
    await runTurn((guids) => {
      relay.capture("The research is done: three options.", guids);
    });
    expect(exchanges.since(0, 10)).toMatchObject([
      { said: "Grok Bot finished task gb-9", kind: "report", via: "texted" },
    ]);
  });

  test("a spoken request and a tell in one batch: spoken to the line AND texted", async () => {
    const { relay, exchanges, queue, runTurn } = rig();
    const answer = relay.ask("what time is it");
    relay.tell("also water the plants");
    let taken: { spoken: boolean; textToo: boolean } | undefined;
    await runTurn(
      (guids) => {
        taken = relay.capture("Ten past nine; I'll see to the plants.", guids);
      },
      0,
      [queue[1]!.msg],
    );
    expect(taken).toEqual({ spoken: true, textToo: true });
    expect(await answer).toBe("Ten past nine; I'll see to the plants.");
    expect(exchanges.since(0, 10).map((e) => e.kind ?? "ask")).toEqual(
      expect.arrayContaining(["ask", "tell"]),
    );
  });

  test("a tell does not hold up a later spoken request's timeout", async () => {
    const { relay, runTurn } = rig({ answerTimeoutMs: 30 });
    relay.tell("something slow");
    const line = await relay.ask("hello?");
    expect(line).toBe("working on it");
    // The tell's turn can still run afterwards without disturbing anything.
    await runTurn(() => {}, 0);
  });

  test("tell entries whose turn never ends are swept, not kept forever", () => {
    let now = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "grok-relay-"));
    dirs.push(dir);
    const queue: Pending[] = [];
    const relay = new GrokRelay({
      handle: HANDLE,
      contacts: { canon: (h) => h },
      enqueue: (key, msg) => queue.push({ key, msg }),
      exchanges: new ExchangeLog(dir),
      answerTimeoutMs: 100,
      slowReply: "later",
      maxReplyChars: 100,
      now: () => now,
    });
    relay.tell("one");
    now += 3 * 60 * 60_000;
    relay.tell("two");
    // The first guid is no longer tracked: its capture is a no-op.
    expect(relay.capture("late", [queue[0]!.msg.msgGuid])).toEqual({
      spoken: false,
      textToo: false,
    });
    expect(relay.capture("now", [queue[1]!.msg.msgGuid])).toEqual({ spoken: false, textToo: true });
  });
});

describe("report routing by origin", () => {
  const GUID = "any;+;chat123456789";
  const GROUP_KEY = `imessage:group:${GUID}`;
  const group = { sessionKey: GROUP_KEY, chatGuid: GUID, isGroup: true };
  const text = "Grok Bot finished task gb-1. Here is the result.";
  const said = "Grok Bot finished task gb-1";

  test("a report for a task asked in a group wakes that group's session, as a group inbound", () => {
    const { relay, queue } = rig();
    relay.report(text, said, undefined, group);
    expect(queue).toHaveLength(1);
    const { key, msg } = queue[0]!;
    expect(key).toBe(GROUP_KEY);
    // The key is exactly what the pipeline derives for a text typed in that group.
    expect(sessionKeyFor(msg, { canon: (h) => h })).toBe(GROUP_KEY);
    expect(msg.isGroup).toBe(true);
    expect(msg.chatGuid).toBe(GUID);
    expect(msg.chatIdentifier).toBe("chat123456789");
    expect(msg.service).toBe(GROK_REPORT_SERVICE);
    expect(msg.text).toBe(text);
    expect(msg.rowId).toBeLessThan(0);
    expect(msg.fromMe).toBe(false);
  });

  test("it is still a bot's report, not an instruction: same service, caller and text", () => {
    const { relay, queue } = rig();
    const bot = { kind: "bot", bot: "glep" } as const;
    relay.report(text, said, bot, group);
    const { msg } = queue[0]!;
    expect(isGrokAsyncInbound(msg)).toBe(true);
    expect(isGrokInbound(msg)).toBe(false);
    expect(msg.grokCaller).toEqual(bot);
    expect(grokTurnOf([msg])).toEqual({ msgGuids: [msg.msgGuid], spoken: false, alsoText: false });
  });

  test("the chat guid the DM resolver knows is not used for a group", () => {
    const { relay, queue } = rig({ chatGuidFor: () => "any;-;should-not-be-used" });
    relay.report(text, said, undefined, group);
    expect(queue[0]?.msg.chatGuid).toBe(GUID);
  });

  test("the reply to a group report is texted (never spoken) and logged as a report", async () => {
    const { relay, exchanges, runTurn } = rig();
    relay.report(text, said, undefined, group);
    let taken: { spoken: boolean; textToo: boolean } | undefined;
    await runTurn((guids) => {
      taken = relay.capture("Glep found three options.", guids);
    });
    expect(taken).toEqual({ spoken: false, textToo: true });
    expect(exchanges.since(0, 10)).toMatchObject([
      { said, reply: "Glep found three options.", kind: "report", via: "texted" },
    ]);
  });

  test("no origin: the owner's DM, exactly as before", () => {
    const { relay, queue } = rig();
    relay.report(text, said);
    const { key, msg } = queue[0]!;
    expect(key).toBe(DM_KEY);
    expect(msg.isGroup).toBe(false);
    expect(msg.chatGuid).toBe(`any;-;${HANDLE}`);
    expect(msg.fromHandle).toBe(HANDLE);
  });

  test("a DM origin uses the DM's own chat guid, as before", () => {
    const { relay, queue } = rig({ chatGuidFor: () => "any;-;real-dm-guid" });
    relay.report(text, said, undefined, { sessionKey: DM_KEY, chatGuid: "", isGroup: false });
    const { key, msg } = queue[0]!;
    expect(key).toBe(DM_KEY);
    expect(msg.isGroup).toBe(false);
    expect(msg.chatGuid).toBe("any;-;real-dm-guid");
  });

  test.each([
    ["an empty chat guid", { sessionKey: GROUP_KEY, chatGuid: "  ", isGroup: true }],
    [
      "a key that is not the one the guid maps to",
      { sessionKey: "imessage:group:any;+;other", chatGuid: GUID, isGroup: true },
    ],
    ["an sms group key", { sessionKey: "sms:group:CH1", chatGuid: "CH1", isGroup: true }],
    [
      "an orchestrator group key",
      { sessionKey: `orch:desmond:group:${GUID}`, chatGuid: GUID, isGroup: true },
    ],
  ])("%s falls back to the owner's DM instead of a wrong session", (_name, origin) => {
    const { relay, queue } = rig();
    relay.report(text, said, undefined, origin);
    const { key, msg } = queue[0]!;
    expect(key).toBe(DM_KEY);
    expect(msg.isGroup).toBe(false);
    expect(msg.chatGuid).toBe(`any;-;${HANDLE}`);
  });

  test("tell and ask never take an origin: they stay in the owner's DM", () => {
    const { relay, queue } = rig();
    relay.tell("hello");
    void relay.ask("hello?");
    expect(queue.map((q) => q.key)).toEqual([DM_KEY, DM_KEY]);
    expect(queue.every((q) => !q.msg.isGroup)).toBe(true);
  });
});
