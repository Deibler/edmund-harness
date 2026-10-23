/**
 * A stand-in for the CLI a sub-agent runs. FAKE_AGENT_MODE picks what it does:
 *   finish   — one assistant message, a result, exit 0
 *   hang     — one assistant message, then silence until killed
 *   model404 — the CLI's own words for a model it cannot use, exit 1
 */
const mode = process.env.FAKE_AGENT_MODE ?? "finish";
await Bun.stdin.text(); // the task, as the runner writes it
const out = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);
const say = (text: string) =>
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });

if (mode === "model404") {
  const result =
    "There's an issue with the selected model (claude-test-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
  out({ type: "result", subtype: "success", is_error: true, result });
  process.exit(1);
}
say("found three sources so far: a, b, c");
if (mode === "hang") {
  setInterval(() => {}, 60_000);
} else {
  out({ type: "result", subtype: "success", result: "final: a, b, c", total_cost_usd: 0.01 });
  process.exit(0);
}
