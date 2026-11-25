#!/usr/bin/env bun
/**
 * Does this Bun survive worker threads being created and terminated?
 *
 *   bun scripts/bun-worker-churn/check.ts [rounds]
 *
 * Run it before moving the daemon to another Bun. Each round starts a worker
 * that loads a package and terminates it, then starts and terminates eight
 * plain workers, which is what the daemon did when its embedder was a worker
 * thread. A sound runtime finishes with every load working and exits 0. An
 * unsound one answers "Cannot find module" for a package that is on disk,
 * from some round onward (exit 1), or crashes outright.
 *
 * Measured 2026-11-25 on macOS arm64, 2,500 rounds a run:
 *   Bun 1.3.9   failed 4 of 4 runs within 230 rounds (3 segfaults in the
 *               module resolver, 1 with every load failing from round 227)
 *   Bun 1.3.14  0 of 10 here, but it dies with "NAPI FATAL ERROR" the moment
 *               a worker holding a loaded ONNX model is terminated (15 of 15)
 *   Bun 1.4.5   0 of 10, and 0 of 15 with the real model
 * This file as it stands crashed Bun 1.3.9 in 2 of 3 runs of 1,200 rounds.
 * One clean run proves little: run it several times. The daemon no longer
 * loads a package in a worker (tests/worker-thread-imports.test.ts), so this
 * is about the runtime, not about a regression in the daemon.
 *
 * The two workers live in folders this file never imports from. That is
 * deliberate: the fault shows fastest when a worker thread is the first to
 * touch a folder as well as a package.
 */
const rounds = Number(process.argv[2] ?? 2500);
const loader = new URL("./loads-a-package/worker.ts", import.meta.url);
const plain = new URL("./plain/worker.ts", import.meta.url);

function once(url: URL, message: unknown): Promise<string> {
  return new Promise((resolve) => {
    const worker = new Worker(url);
    const timer = setTimeout(() => finish("timed out"), 60_000);
    const finish = (result: string) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) =>
      finish(event.data.ok ? "ok" : (event.data.error ?? "failed"));
    worker.onerror = (event: ErrorEvent) => finish(`worker error: ${event.message}`);
    worker.postMessage(message);
  });
}

let failed = 0;
let firstFailure = 0;
let lastError = "";
for (let round = 1; round <= rounds; round++) {
  const result = await once(loader, 1);
  if (result !== "ok") {
    failed++;
    firstFailure ||= round;
    lastError = result;
  }
  for (let i = 0; i < 8; i++) {
    const rows = Array.from({ length: 200 }, () => ({ v: Math.random() }));
    await once(plain, { rows, n: i * 10 });
  }
  if (round % 500 === 0) console.log(`round ${round} of ${rounds}: ${failed} failed loads`);
}

if (failed > 0) {
  console.log(
    `UNSOUND on Bun ${Bun.version}: ${failed} of ${rounds} loads failed, from round ${firstFailure} on`,
  );
  console.log(`  ${lastError.slice(0, 200)}`);
  process.exit(1);
}
console.log(
  `clean on Bun ${Bun.version}: ${rounds} rounds, ${rounds * 9} workers, every load worked`,
);
