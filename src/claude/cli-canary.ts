import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorAlert } from "../alerts/operator-alert.ts";
import { log } from "../util/log.ts";
import { ISOLATED_SETTINGS_ARGS, directClaudeEnv } from "./direct-env.ts";
import { runClaudeOneShot } from "./one-shot.ts";
import { Worker } from "./worker.ts";

/**
 * The Claude Code CLI updates underneath Edmund on purpose: a new model can
 * need a new CLI, and the operator runs `claude update` without touching the
 * harness. Three versions landed in two days in October 2026. What the
 * harness owes in return is noticing when an update changes something it
 * depends on: the flags it passes, the stream-json protocol the warm workers
 * speak, the wording of its errors.
 *
 * So the version is read on boot and every half hour, and a new one gets a
 * canary through the two real spawn paths: a one-shot with the harness's own
 * flags, and a stream-json worker turn. A failure alerts the operator with
 * the version and the step that broke, before people notice it as silence.
 */

const CHECK_EVERY_MS = 30 * 60_000;

export type CliVersionRecord = {
  version: string;
  checkedAt: string;
  canary: "ok" | "failed";
  detail?: string;
};

export type CanaryResult = { ok: true } | { ok: false; step: string; detail: string };

/** `claude --version` → "2.1.310", or null when the CLI cannot be run. */
export function claudeCliVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 20_000);
    proc.stdout.on("data", (c) => {
      out += c.toString();
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(parseCliVersion(out));
    });
  });
}

export function parseCliVersion(text: string): string | null {
  return text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

/** The last version a canary ran against, from data/cli-version.json. */
export function readVersionRecord(dataDir: string): CliVersionRecord | null {
  const path = join(dataDir, "cli-version.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliVersionRecord;
  } catch {
    return null;
  }
}

/**
 * The two paths every turn depends on, with the flags the harness really
 * passes. Each must come back with the word asked for.
 */
export async function runCliCanary(model: string): Promise<CanaryResult> {
  const oneShot = await runClaudeOneShot({
    args: ["--model", model, "--append-system-prompt", "You are a health check. Follow it exactly."],
    input: "Reply with exactly the word OK and nothing else.",
    timeoutMs: 120_000,
  });
  if (!oneShot.ok || !/\bOK\b/.test(oneShot.text)) {
    return {
      ok: false,
      step: "one-shot",
      detail: (oneShot.error ?? `unexpected reply: ${oneShot.text.slice(0, 120)}`).slice(0, 300),
    };
  }

  const cwd = mkdtempSync(join(tmpdir(), "edmund-cli-canary-"));
  const worker = new Worker({
    argv: [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      ...ISOLATED_SETTINGS_ARGS,
      "--no-session-persistence",
      "--strict-mcp-config",
      "--tools",
      "",
      "--model",
      model,
    ],
    env: directClaudeEnv(),
    cwd,
    perTurnIdleMs: 120_000,
    sessionKey: "cli-canary",
  });
  try {
    const line = JSON.stringify({
      type: "user",
      uuid: crypto.randomUUID(),
      message: {
        role: "user",
        content: [{ type: "text", text: "Health check: reply with exactly the word OK." }],
      },
    });
    const r = await worker.turn({ stdinPayload: `${line}\n` });
    if (!r.ok) return { ok: false, step: "stream-json worker", detail: r.error.slice(0, 300) };
    if (!/\bOK\b/.test(r.reply)) {
      return {
        ok: false,
        step: "stream-json worker",
        detail: `unexpected reply: ${r.reply.slice(0, 120)}`,
      };
    }
    return { ok: true };
  } finally {
    await worker.shutdown("cli canary done").catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Check the installed version; on a version not yet checked, run the canary,
 * record the outcome, and alert the operator on failure.
 */
export async function checkCliVersion(deps: {
  dataDir: string;
  model: string;
  alert: Pick<OperatorAlert, "notify">;
  readVersion?: () => Promise<string | null>;
  canary?: (model: string) => Promise<CanaryResult>;
}): Promise<CliVersionRecord | null> {
  const version = await (deps.readVersion ?? claudeCliVersion)();
  if (!version) {
    await deps.alert.notify({
      category: "Claude CLI not runnable",
      error: "`claude --version` did not answer; every turn will fail until the CLI is fixed.",
    });
    return null;
  }
  const last = readVersionRecord(deps.dataDir);
  if (last?.version === version && last.canary === "ok") return last;

  const result = await (deps.canary ?? runCliCanary)(deps.model);
  const record: CliVersionRecord = {
    version,
    checkedAt: new Date().toISOString(),
    canary: result.ok ? "ok" : "failed",
    ...(result.ok ? {} : { detail: `${result.step}: ${result.detail}` }),
  };
  writeFileSync(join(deps.dataDir, "cli-version.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (result.ok) {
    log.info("cli-canary", "Claude CLI checked", {
      version,
      previous: last?.version ?? "none",
    });
  } else {
    log.error("cli-canary", "Claude CLI canary failed", { version, step: result.step });
    await deps.alert.notify({
      category: "Claude CLI update broke something",
      error: `CLI ${version} (was ${last?.version ?? "unknown"}) failed the ${result.step} check: ${result.detail}`,
    });
  }
  return record;
}

/** Check on boot (after a delay) and every half hour. */
export function startCliWatch(deps: {
  dataDir: string;
  model: string;
  alert: Pick<OperatorAlert, "notify">;
}): void {
  const tick = () => {
    checkCliVersion(deps).catch((err) =>
      log.warn("cli-canary", "check threw", { err: (err as Error).message }),
    );
  };
  setTimeout(tick, 90_000).unref?.();
  setInterval(tick, CHECK_EVERY_MS).unref?.();
}
