/**
 * Run by tests/log-instrument.test.ts in a process of its own: the hooks under
 * test replace process-wide functions. Does one of each thing a process can do
 * that no call site logs, then ends the way the first argument says.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { withAccessLog } from "../../src/util/access-log.ts";
import { withLogContext } from "../../src/util/log-context.ts";
import { installLogSink } from "../../src/util/log-sink.ts";

const [dataDir, ending] = process.argv.slice(2) as [string, string];
installLogSink(dataDir, "", "daemon.log", { echo: false });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: withAccessLog("test-server", (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/private") return new Response("no", { status: 403 });
    return new Response("ok");
  }),
});
const base = `http://127.0.0.1:${server.port}`;

await withLogContext({ session: "imessage:dm:+15550100001", turn: "model_turn_x" }, async () => {
  await fetch(`${base}/v1/items/abcdef0123456789abcdef0123456789?api_key=sk-secret-value`, {
    method: "POST",
    headers: { authorization: "Bearer sk-secret-value", "user-agent": "test-agent" },
    body: "a body that must not be logged",
  });
});
await fetch(`${base}/private`);
await fetch("http://127.0.0.1:9/unreachable").catch(() => {});

spawnSync("true");
execFileSync("true");
spawnSync("sh", ["-c", "exit 3"]);
await new Promise<void>((resolve) => spawn("true").on("exit", () => resolve()));
await Bun.spawn(["echo", "--token", "sk-secret-value", "hello"], { stdout: "ignore" }).exited;
Bun.spawnSync(["true"]);

server.stop(true);
await Bun.sleep(20);

if (ending === "throw") {
  setTimeout(() => {
    throw new Error("the daemon fell over");
  }, 1);
} else if (ending === "reject") {
  void fetch("http://127.0.0.1:9/nobody-handles-this");
} else {
  process.exit(0);
}
