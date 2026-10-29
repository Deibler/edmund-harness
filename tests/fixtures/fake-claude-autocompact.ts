/**
 * A stand-in for `claude -p --input-format stream-json` whose turn crosses
 * the auto-compact window: one large API call, the CLI compacting by itself,
 * then the turn carrying on. The status and compact_boundary lines copy what
 * CLI 2.1.312 printed on 2026-10-29 (trigger, pre_tokens, post_tokens,
 * cumulative_dropped_tokens). The result's usage sums every call, as the real
 * one does, so a parser that falls back to it reads the pre-compaction size.
 *
 *   --no-post-tokens   the boundary carries no post_tokens
 *   --no-call-after    nothing follows the boundary but the result
 *   --echo-compact     a /compact is answered with the text it was sent
 */
const replay = process.argv.includes("--replay-user-messages");
const noPost = process.argv.includes("--no-post-tokens");
const noCallAfter = process.argv.includes("--no-call-after");
const echoCompact = process.argv.includes("--echo-compact");
const sid = "fake-session";
const out = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);

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
    out({ type: "system", subtype: "init", session_id: sid });
    if (replay) out({ type: "user", isReplay: true, uuid: msg.uuid, message: msg.message });
    const text: string = msg.message.content[0].text;
    if (echoCompact && text.startsWith("/compact")) {
      out({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        result: text,
        session_id: sid,
      });
      continue;
    }
    out({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        model: "fake",
        usage: { cache_read_input_tokens: 238_000, input_tokens: 2_000 },
      },
      session_id: sid,
    });
    out({ type: "system", subtype: "status", status: "compacting", session_id: sid });
    out({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      session_id: sid,
    });
    out({
      type: "system",
      subtype: "compact_boundary",
      session_id: sid,
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 240_000,
        ...(noPost ? {} : { post_tokens: 18_000 }),
        cumulative_dropped_tokens: 222_000,
      },
    });
    if (!noCallAfter) {
      out({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "done" }],
          model: "fake",
          usage: { cache_read_input_tokens: 28_000, input_tokens: 2_000 },
        },
        session_id: sid,
      });
    }
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: "done",
      session_id: sid,
      usage: { cache_read_input_tokens: 266_000, input_tokens: 4_000 },
    });
  }
});
