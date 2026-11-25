// Owns one real embedding process, prints its pid, then waits to be killed.
// The model is never loaded: nothing is ever asked of the process.
const script = new URL("../../src/memory/transformers-embed-child.ts", import.meta.url).pathname;
const child = Bun.spawn([process.execPath, script], {
  stdio: ["ignore", "ignore", "inherit"],
  serialization: "advanced",
  ipc(message: { ready?: boolean }) {
    if (message.ready) console.log(child.pid);
  },
});
setInterval(() => {}, 1000);
