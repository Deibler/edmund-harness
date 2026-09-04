import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CronStore } from "../cron/store.ts";
import { isBackgroundable } from "./registry.ts";
import type { BgJob, BgJobStore } from "./store.ts";
import { randomJobId } from "./store.ts";

/**
 * Spawn a detached background runner. The runner executes one tool call
 * (dispatched by name via BG_EXECUTORS), saves output to the sandbox,
 * and fires a cron wake-up event when done so the parent session is
 * re-invoked without polling.
 *
 * Works for any tool registered in `registry.ts` — Cloudflare, image/video/
 * audio generation, web fetch, transcription, etc.
 */

const RUNNER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "bg-runner.ts",
);

export function spawnBgJob(params: {
  store: BgJobStore;
  crons: CronStore;
  dataDir: string;
  sessionKey: string;
  sandboxPath: string;
  toolName: string;
  args: Record<string, unknown>;
  configPath: string;
}): BgJob {
  if (!isBackgroundable(params.toolName)) {
    throw new Error(`Tool ${params.toolName} does not support background execution`);
  }
  const id = randomJobId();
  const argsJson = JSON.stringify(params.args);
  const job = params.store.create({
    id,
    sessionKey: params.sessionKey,
    sandboxPath: params.sandboxPath,
    toolName: params.toolName,
    argsJson,
  });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BG_JOB_ID: job.id,
    BG_TOOL_NAME: params.toolName,
    BG_TOOL_ARGS_JSON: argsJson,
    BG_SESSION_KEY: params.sessionKey,
    BG_SANDBOX_PATH: resolve(params.sandboxPath),
    EDMUND_DATA_DIR: resolve(params.dataDir),
    EDMUND_CONFIG_PATH: resolve(params.configPath),
  };

  const child = spawn("bun", [RUNNER_SCRIPT], {
    env,
    detached: true,
    stdio: "ignore",
  });

  child.on("error", (err) => {
    // finish() is a synchronous SQLite write — the exit handler below
    // re-reads the row and skips when status is already "failed", so
    // the two handlers can't both fire a wake-up. If finish() ever
    // becomes async, that guard breaks and you need explicit dedup.
    params.store.finish(job.id, "failed", null, null, `spawn error: ${err.message}`);
    fireFailureWakeUp(params, job.id, `spawn error: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    // If the child exits without the runner having updated the row (crashed
    // before running or during), mark it failed + fire wake-up. The runner
    // itself handles its normal exit path; this is only the unexpected case.
    if (code === null && signal) {
      const current = params.store.get(job.id);
      if (current && current.status !== "done" && current.status !== "failed") {
        params.store.finish(job.id, "failed", null, null, `child died via signal=${signal}`);
        fireFailureWakeUp(params, job.id, `child died via signal=${signal}`);
      }
    }
  });
  child.unref();

  return job;
}

function fireFailureWakeUp(
  params: {
    store: BgJobStore;
    crons: CronStore;
    sessionKey: string;
    toolName: string;
  },
  jobId: string,
  reason: string,
): void {
  try {
    const body = [
      `Background tool job FAILED (status: failed).`,
      ``,
      `Job id: ${jobId}`,
      `Tool: ${params.toolName}`,
      `Error: ${reason}`,
      ``,
      `The user is waiting. Apologize briefly and suggest a retry.`,
    ].join("\n");
    params.crons.create({
      sessionKey: params.sessionKey,
      systemEvent: body,
      schedule: { kind: "once", atMs: Date.now() + 2_000 },
    });
    params.crons.cancelPokes(params.sessionKey);
    // Stamp wake_fired_at so the reaper's listFinishedMissingWake
    // doesn't fire a duplicate on the next sweep.
    params.store.markWakeFired(jobId);
  } catch {
    // best-effort; reaper will catch it
  }
}
