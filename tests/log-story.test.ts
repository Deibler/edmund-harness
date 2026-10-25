import { describe, expect, test } from "bun:test";
import { parseLine } from "../cli/commands/logs.ts";
import {
  THREAD_PALETTE,
  describeStep,
  field,
  jsonString,
  newStoryState,
  tell,
  threadColors,
  workingLine,
} from "../cli/log-story.ts";

/** Lines in the daemon's real formats (2026-10-25), handles and names made up. */
const L = {
  mirror: "2026-10-25T20:11:45.000Z [log] [mirror] screen disconnected",
  mirrorWarn: "2026-10-25T20:29:40.000Z [warn] [mirror] liveness timeout; reconnecting",
  recall: "2026-10-25T20:08:15.000Z [log] [recall] +1 msg  msgs ▓▓▓▓▓▓▓▓▓▓ 100% · 49k indexed",
  watcher:
    "2026-10-25T20:07:31.000Z [log] [watcher] message finished being written, delivering row=51923 waited_ms=7",
  poolStats: "2026-10-25T20:10:48.000Z [log] [claude-pool] stats (10m) hits=1 misses=0 hit_pct=100",
  sms: "2026-10-25T20:13:42.000Z [log] [sms] spend today: $0.0000 (0 in / 0 out)",
  inbound:
    "2026-10-25T20:24:59.785Z [log] [inbound] dm:+15555550101 ← Sam Rivera  1msg  env=744ch ~186tok  recall=4[4d] (3720+2533ms)",
  inboundGroup:
    "2026-10-25T20:23:46.075Z [log] [inbound] group:2045d3… ← Sam Rivera  2msgs  env=4147ch ~1037tok  recall=0 (61269+4338ms)  attach=1  hist=11",
  pool: "2026-10-25T20:24:59.900Z [log] [claude-pool] HIT (warm reuse, idle 21.0s) session=dm:+15555550101 pool_size=2",
  bash: String.raw`2026-10-25T20:25:00.000Z [log] [claude-worker] tool_use Bash session=dm:+15555550101 id=toolu_1 input_summary="{\"command\":\"ls -la\",\"description\":\"List the sandbox\"}"`,
  bashQuoted: String.raw`2026-10-25T20:25:01.000Z [log] [claude-worker] tool_use Bash session=dm:+15555550101 id=toolu_2 input_summary="{\"command\":\"grep -n -i \\"hook\\" tracker.md${"…"}(len=134)\"}"`,
  toolSearch: String.raw`2026-10-25T20:25:02.000Z [log] [claude-worker] tool_use ToolSearch session=dm:+15555550101 id=toolu_3 input_summary="{\"query\":\"select:x\"}"`,
  mcpCall: String.raw`2026-10-25T20:25:03.000Z [log] mcp[dm:+15555550101] [tool] ${"→"} send_message args="{\"text\":\"hi\"}"`,
  mcpOk:
    "2026-10-25T20:25:03.400Z [log] mcp[dm:+15555550101] [tool] ✓ send_message dur=394ms reply=sent",
  mcpFail:
    '2026-10-25T20:25:04.000Z [log] mcp[dm:+15555550101] [tool] ✗ remember_about_subject dur=10ms reply="remember_about_subject failed: leave out phone numbers"',
  result:
    "2026-10-25T20:25:05.000Z [log] [claude-worker] result ok session=dm:+15555550101 dur=2.8s model=m provider=anthropic tools=2 reply_chars=81 tokens=*** ctx=158k cache=100% session_total=$769.65",
  outbound: "2026-10-25T20:25:05.500Z [log] [outbound] dm:+15555550101 → sent  1 chunk",
  spawn:
    '2026-10-23T20:52:13.311Z [log] mcp[dm:+15555550101] [agents] spawned agent_20261023T205213_2762f4_1 pid=95196 task="Build a candidate sourcing list"',
  agentStart:
    '2026-10-23T20:52:13.364Z [log] agent[agent_20261023T205213_2762f4_1] [agent] runner starting id=agent_20261023T205213_2762f4_1 task="Build"',
  agentStep: String.raw`2026-10-23T20:52:19.689Z [log] mcp[agent:agent_20261023T205213_2762f4_1] [tool] ${"→"} web_search args="{\"query\":\"superintendent open to work\",\"count\":10}"`,
  agentDone:
    '2026-10-24T07:49:23.214Z [log] [cron] fire agent-done job=job_1 session=dm:+15555550101 schedule=once event="A sub-agent you spawned has finished (status: done). Agent id: agent_x Task was: Build a candidate sourcing list"',
  cronOk: "2026-10-25T20:06:46.467Z [log] [cron] fire ok scheduled job=job_1 chunks=1 dur=29m13s",
  cronFire:
    '2026-10-25T21:00:00.062Z [log] [cron] fire scheduled job=job_2 session=mirror:pi-4 schedule=cron event="Severe-weather check"',
  unknown: "2026-10-25T20:22:02.000Z [log] [bridge] supervising Messages pid=91831 connected=true",
};

const run = (lines: string[], lookup?: (s: string) => string | null) => {
  const state = newStoryState(lookup);
  return {
    state,
    out: lines.map((l) => tell(parseLine(l), state, Date.parse("2026-10-25T20:26:00Z"))),
  };
};

describe("the story view hides the heartbeat", () => {
  test("background chatter is hidden, warnings from it too", () => {
    const { out } = run([
      L.mirror,
      L.mirrorWarn,
      L.recall,
      L.watcher,
      L.poolStats,
      L.sms,
      L.cronOk,
    ]);
    expect(out).toEqual([null, null, null, null, null, null, null]);
  });

  test("a tool call written three times shows once; a failure still shows", () => {
    const { out } = run([L.bash, L.mcpCall, L.mcpOk, L.mcpFail]);
    expect(out[0]?.event).toBe("Bash");
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
    expect(out[3]?.tone).toBe("bad");
    expect(out[3]?.details).toContain("leave out phone numbers");
  });

  test("bookkeeping tools are hidden", () => {
    expect(run([L.toolSearch]).out[0]).toBeNull();
  });

  test("a line it does not know is shown as it was", () => {
    const told = run([L.unknown]).out[0]!;
    expect(told.event).toBe("supervising Messages");
    expect(told.details).toContain("pid=91831");
  });
});

describe("the story view says who and what", () => {
  test("a DM is named by the person who wrote, and every later line uses the name", () => {
    const { out } = run([L.inbound, L.pool, L.bash, L.result, L.outbound]);
    expect(out.map((o) => o?.who)).toEqual(Array(5).fill("Sam Rivera"));
    expect(out[0]?.event).toBe("← Sam Rivera");
    expect(out[1]).toMatchObject({ kind: "model", event: "working", details: "warm" });
    expect(out[2]).toMatchObject({ kind: "step", event: "Bash", details: "List the sandbox" });
    expect(out[3]?.event).toBe("done in 2.8s");
    expect(out[3]?.details).toBe("2 steps · 81-char reply · ctx 158k · $769.65 session");
    expect(out[4]?.event).toBe("→ reply sent");
  });

  test("a group is named from Messages, its sender in the event", () => {
    const { out } = run([L.inboundGroup], (s) => (s === "group:2045d3…" ? "Axolotl crew" : null));
    expect(out[0]).toMatchObject({
      who: "Axolotl crew",
      event: "← Sam Rivera",
      details: "2 msgs, 1 attachment",
    });
  });

  test("a step shows its purpose, quoting what the model typed", () => {
    expect(run([L.bashQuoted]).out[0]?.details).toBe('grep -n -i "hook" tracker.md…');
    expect(describeStep("Read", '{"file_path":"/a/b/sandbox/dbg/head.png"}')).toBe("dbg/head.png");
    expect(describeStep("send_message", '{"text":"on it"}')).toBe('"on it"');
    expect(describeStep("web_fetch", '{"url":"https://example.com/x"}')).toBe("example.com/x");
  });

  test("fields read the logger's escaping: quotes escaped, backslashes not", () => {
    const f = field(String.raw`a="x \\"y\\" z" b=2`, "a");
    expect(f).toBe(String.raw`x \"y\" z`);
    expect(jsonString(String.raw`{"c":"say \"hi\""}`, "c")).toBe('say "hi"');
  });

  test("a subagent: started, its own steps under the conversation that spawned it, finished", () => {
    const { out } = run([L.inbound, L.spawn, L.agentStart, L.agentStep, L.agentDone]);
    expect(out[1]).toMatchObject({ kind: "subagent", event: "started", who: "Sam Rivera" });
    expect(out[2]).toBeNull();
    expect(out[3]).toMatchObject({ kind: "step", event: "web_search", who: "↳ 2762f4 Sam Rivera" });
    expect(out[4]).toMatchObject({ kind: "subagent", event: "finished (done)" });
  });

  test("a scheduled wake-up says what it is for", () => {
    expect(run([L.cronFire]).out[0]).toMatchObject({
      kind: "wake",
      who: "the mirror",
      event: "scheduled",
      details: "Severe-weather check",
    });
  });
});

describe("what is still running", () => {
  test("a turn runs from pickup to result and is named in the minute line", () => {
    const { state } = run([L.inbound, L.pool, L.bash, L.bashQuoted]);
    expect(workingLine(state, Date.parse("2026-10-25T20:31:00Z"))).toBe(
      "still working: Sam Rivera 6m, 2 steps, last Bash",
    );
    tell(parseLine(L.result), state);
    expect(workingLine(state, Date.parse("2026-10-25T20:31:00Z"))).toBeNull();
  });

  test("a message Edmund lets pass does not count as work", () => {
    const { state } = run([L.inboundGroup]);
    expect(workingLine(state, Date.now())).toBeNull();
  });

  test("a turn silent for 45 minutes is assumed over", () => {
    const { state } = run([L.inbound, L.pool]);
    expect(workingLine(state, Date.parse("2026-10-25T21:30:00Z"))).toBeNull();
  });
});

describe("one color per conversation", () => {
  test("a group shortened from the end and from the start is one thread", () => {
    const canonical = (s: string) =>
      /^group:(2045d3…|4e1c00…|4e1c00fedec945008aa311b46e2045d3)$/.test(s)
        ? "group:any;+;4e1c00fedec945008aa311b46e2045d3"
        : null;
    const state = newStoryState(() => "Axolotl crew", canonical);
    const turn = tell(parseLine(L.inboundGroup), state);
    const memory = tell(
      parseLine(
        "2026-10-25T20:51:34.824Z [log] [persona-consolidate] operating principles updated handle=any;+;4e1c00fedec945008aa311b46e2045d3 principles=10",
      ),
      state,
    );
    const notes = tell(
      parseLine('2026-10-25T20:51:34.900Z [log] [maintainer] group:4e1c00… → +4 notes reason="x"'),
      state,
    );
    expect(turn?.thread).toBe("group:any;+;4e1c00fedec945008aa311b46e2045d3");
    expect(memory?.thread).toBe(turn?.thread);
    expect(notes?.thread).toBe(turn?.thread);
  });

  test("a subagent's work is colored as the conversation that spawned it", () => {
    const state = newStoryState();
    tell(parseLine(L.spawn), state);
    expect(tell(parseLine(L.agentStep), state)?.thread).toBe("dm:+15555550101");
  });

  test("colors stay distinct within a run and stable for a conversation", () => {
    const pick = threadColors();
    const seen = new Set(
      Array.from({ length: 16 }, (_, i) => pick(`dm:+1555555${String(i).padStart(4, "0")}`)),
    );
    expect(seen.size).toBe(16);
    expect(pick("dm:+15555550003")).toBe(pick("dm:+15555550003"));
    expect(THREAD_PALETTE).not.toContain(196);
  });
});
