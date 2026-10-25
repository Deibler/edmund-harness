/**
 * A stand-in for `claude -p --input-format stream-json --replay-user-messages`
 * that reproduces what CLI 2.1.309 did with a message written mid-turn
 * (probed 2026-10-25). A message written while a tool runs is echoed when the
 * tool returns, joins the turn, and the turn ends in one result. With --late
 * it plays the race the worker guards against: the message misses the turn,
 * which ends first, and then runs as a turn of its own, echo and result after
 * the first result.
 *
 * Each turn calls one "tool" that takes FAKE_TOOL_MS (default 300) unless the
 * message text is "notool", then spends FAKE_FINAL_MS writing its reply. The
 * reply lists any messages that joined the turn.
 */
const late = process.argv.includes("--late");
const toolMs = Number(process.env.FAKE_TOOL_MS ?? 300);
// The model writing its final reply after the tool returns: no tool in flight.
const finalMs = Number(process.env.FAKE_FINAL_MS ?? 0);
const sid = "fake-midturn";
const out = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);
type Msg = { uuid?: string; message: { content: Array<{ text: string }> } };
const textOf = (m: Msg) => m.message.content[0]?.text ?? "";
const echo = (m: Msg) =>
  out({ type: "user", isReplay: true, uuid: m.uuid, message: m.message, session_id: sid });
const result = (text: string, numTurns: number) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: numTurns,
    result: text,
    session_id: sid,
  });

let running = false;
let toolRunning = false;
const queued: Msg[] = [];
const waiting: Msg[] = [];

async function runTurn(m: Msg): Promise<void> {
  running = true;
  out({ type: "system", subtype: "init", session_id: sid });
  echo(m);
  if (textOf(m) === "notool") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "no tool" }] } });
    result("no tool", 1);
  } else {
    out({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] },
    });
    toolRunning = true;
    await Bun.sleep(toolMs);
    toolRunning = false;
    out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    });
    const joined = late ? [] : queued.splice(0);
    for (const q of joined) echo(q);
    if (finalMs > 0) await Bun.sleep(finalMs);
    const reply =
      joined.length > 0 ? `done; saw: ${joined.map(textOf).join(" | ")}` : `done: ${textOf(m)}`;
    out({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    result(reply, 2);
  }
  running = false;
  // What missed the turn runs next, as the CLI does.
  const next = queued.shift() ?? waiting.shift();
  if (next) {
    if (late) {
      out({ type: "system", subtype: "init", session_id: sid });
      echo(next);
      result(`late: ${textOf(next)}`, 1);
      const after = waiting.shift();
      if (after) void runTurn(after);
    } else {
      void runTurn(next);
    }
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl: number;
  // biome-ignore lint/suspicious/noAssignInExpressions: line splitter
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line) as Msg;
    if (!running) void runTurn(m);
    else if (toolRunning) queued.push(m);
    else waiting.push(m);
  }
});
process.stdin.on("end", () => process.exit(0));
