/**
 * A stand-in for `claude -p --input-format stream-json` that replays what the
 * real CLI (2.1.282) printed on 2026-09-24 when resuming a session whose last
 * process was killed with a background shell running: a "stopped" task
 * notification delivered as a turn of its own, with a num_turns 0 result,
 * before the first message on stdin is read. Each message then gets an init,
 * its --replay-user-messages echo (only when that flag is passed), a reply
 * and a result. "/compact" is answered like the real CLI: echo, then a
 * num_turns 0 result.
 */
const replay = process.argv.includes("--replay-user-messages");
const sid = "fake-session";
const out = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);

out({
  type: "system",
  subtype: "task_notification",
  task_id: "b1",
  status: "stopped",
  session_id: sid,
});
out({ type: "system", subtype: "init", session_id: sid });
out({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  result: "",
  session_id: sid,
});

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl: number;
  // biome-ignore lint/suspicious/noAssignInExpressions: line splitter
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const text: string = msg.message.content[0].text;
    const echo = {
      type: "user",
      isReplay: true,
      uuid: msg.uuid,
      message: msg.message,
      session_id: sid,
    };
    out({ type: "system", subtype: "init", session_id: sid });
    if (text === "/compact") {
      if (replay) out(echo);
      out({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        result: "",
        session_id: sid,
      });
      continue;
    }
    if (replay) out(echo);
    const reply = `echo: ${text}`;
    out({
      type: "assistant",
      message: { content: [{ type: "text", text: reply }], model: "fake" },
      session_id: sid,
    });
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: reply,
      session_id: sid,
    });
  }
});
