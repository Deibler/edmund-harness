#!/usr/bin/env bun
/**
 * Generic detached runner for background tool jobs.
 *
 * Env inputs (set by spawnBgJob):
 *   BG_JOB_ID, BG_TOOL_NAME, BG_TOOL_ARGS_JSON,
 *   BG_SESSION_KEY, BG_SANDBOX_PATH,
 *   EDMUND_DATA_DIR, EDMUND_CONFIG_PATH
 *
 * Lifecycle:
 *   1. Mark bg_job row as running (pid=self)
 *   2. Look up executor from BG_EXECUTORS registry by BG_TOOL_NAME
 *   3. Execute — saves output to the sandbox where applicable
 *   4. Update row with status=done|failed + result path/summary
 *   5. Create a cron row so the parent session wakes up and delivers
 *   6. Cancel any pending self-pokes (they're redundant now)
 */

import { BG_EXECUTORS } from "../src/background/registry.ts";
import { BgJobStore } from "../src/background/store.ts";
import { loadConfig } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import { installLogSinkFromEnv } from "../src/util/log-sink.ts";
import { log } from "../src/util/log.ts";

const jobId = must("BG_JOB_ID");
const toolName = must("BG_TOOL_NAME");
const argsJson = must("BG_TOOL_ARGS_JSON");
const sessionKey = must("BG_SESSION_KEY");
const sandboxPath = must("BG_SANDBOX_PATH");
const dataDir = must("EDMUND_DATA_DIR");
const configPath = must("EDMUND_CONFIG_PATH");

installLogSinkFromEnv(`bg[${jobId}] `);
log.info("bg", "runner starting", { id: jobId, tool: toolName });

const bgStore = new BgJobStore(dataDir);

// Best-effort: wrap EVERY exit path with a wake-up fire so the parent
// session is never left hanging, even if the executor throws, the config
// fails to load, or something exits unexpectedly.
let wakeUpFired = false;

function fireWakeUp(status: "done" | "failed", summary: string, resultPath?: string | null): void {
  if (wakeUpFired) return;
  wakeUpFired = true;
  try {
    const crons = new CronStore(dataDir);
    const header =
      status === "done"
        ? `Background tool job finished (status: done).`
        : `Background tool job FAILED (status: failed).`;
    const body = [
      header,
      ``,
      `Job id: ${jobId}`,
      `Tool: ${toolName}`,
      ``,
      summary,
      ``,
      status === "done" && resultPath && isImagePath(resultPath)
        ? `MANDATORY NEXT ACTION: the user has NOT seen this image yet — it only exists on disk. Call send_attachment("${resultPath}") right now to deliver it. Do NOT describe it in text as if the user is looking at it; you can add a one-line caption alongside the send_attachment call if you want.`
        : status === "done"
          ? `The user is waiting. If this produced a file (audio/video/PDF/etc.), call send_attachment with the saved path. Otherwise relay the result inline in Edmund's voice.`
          : summary.includes("GENERATION REFUSED")
            ? // A credits refusal carries its own exact instructions (do not
              // retry, send the top-up link); the generic retry advice below
              // would contradict them.
              `The user is waiting. Follow the instructions in the refusal above exactly.`
            : `The user is waiting. Apologize briefly ("that didn't work" / "site was acting up") and suggest a retry or alternative.`,
    ].join("\n");
    // Deliberately NOT inlining the generated image on this wake-up. We
    // tried that — the model saw the image and described it like the
    // user could see it too ("cover art for the memoir, Cooper looking
    // dignified...") instead of calling send_attachment. The user got
    // a caption with no image. The model has no need to see the file
    // it just generated; the path in the envelope plus the MANDATORY
    // instruction above is enough to route it. Annotate/edit flows that
    // genuinely need vision pass attachImages through their own paths.
    const attachImages = undefined;
    crons.create({
      sessionKey,
      systemEvent: body,
      schedule: { kind: "once", atMs: Date.now() + 2_000 },
      attachImages,
    });
    // Cancel any pending self-pokes — the wake-up event covers this work now.
    crons.cancelPokes(sessionKey);
    // Stamp wake_fired_at AFTER cron is durable. The reaper looks for
    // finished jobs missing this stamp to recover the case where the
    // runner crashed between finish() and crons.create().
    bgStore.markWakeFired(jobId);
  } catch (err) {
    log.error("bg", "fireWakeUp failed", { id: jobId, err: String(err).slice(0, 200) });
  }
}

function isImagePath(p: string): boolean {
  return /\.(jpe?g|png|gif|webp|heic|heif|tiff|bmp)$/i.test(p);
}

// Catch-alls: if the process is killed unexpectedly, at least try to
// mark failed + fire a wake-up before exiting.
process.on("uncaughtException", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("bg", "uncaughtException", { id: jobId, err: msg.slice(0, 200) });
  try {
    bgStore.finish(jobId, "failed", null, null, `uncaught: ${msg}`);
  } catch {}
  fireWakeUp("failed", `uncaught exception: ${msg}`);
  process.exit(3);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error("bg", "unhandledRejection", { id: jobId, err: msg.slice(0, 200) });
  try {
    bgStore.finish(jobId, "failed", null, null, `unhandled rejection: ${msg}`);
  } catch {}
  fireWakeUp("failed", `unhandled rejection: ${msg}`);
  process.exit(4);
});

bgStore.setRunning(jobId, process.pid);

const started = Date.now();

try {
  const executor = BG_EXECUTORS[toolName];
  if (!executor) {
    throw new Error(
      `Unknown tool: ${toolName}. Registered: ${Object.keys(BG_EXECUTORS).join(", ")}`,
    );
  }

  const config = loadConfig(configPath);
  const args = JSON.parse(argsJson) as Record<string, unknown>;

  const result = await executor(args, { config, sandboxPath, sessionKey, dataDir });
  const durMs = Date.now() - started;

  bgStore.finish(jobId, "done", result.resultPath, result.summary, null);
  log.info("bg", "runner done", { id: jobId, dur_ms: durMs, path: result.resultPath });

  fireWakeUp("done", result.summary, result.resultPath);
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const durMs = Date.now() - started;
  bgStore.finish(jobId, "failed", null, null, msg);
  log.error("bg", "runner failed", { id: jobId, dur_ms: durMs, err: msg });
  fireWakeUp("failed", msg);
  process.exit(1);
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[bg-runner] missing env: ${name}`);
    process.exit(2);
  }
  return v;
}
