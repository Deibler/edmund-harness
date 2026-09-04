/**
 * `edmund cron list [--session <key>]`          list active jobs
 * `edmund cron delete <id>` | `--delete <id>`   cancel a specific job
 * `edmund cron cancel-pokes <session>`          cancel self-pokes for a session
 */

import { loadConfig } from "../../src/config/config.ts";
import { CronStore } from "../../src/cron/store.ts";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import { color, fail, info, ok, print, section, table } from "../ui.ts";

export async function cronCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0];
  const inlineDeleteId = getString(p, "delete");

  if (inlineDeleteId) return remove(inlineDeleteId);
  if (!sub || sub === "list" || sub === "ls") return list(p);
  if (sub === "delete" || sub === "cancel" || sub === "rm") return remove(p.positional[1]);
  if (sub === "cancel-pokes") return cancelPokes(p.positional[1]);

  fail(`unknown cron subcommand: ${sub}`);
  info(`usage: edmund cron [list|delete <id>|cancel-pokes <session>]`);
  process.exit(2);
}

function list(p: Parsed): void {
  const cfg = loadConfig();
  const store = new CronStore(cfg.paths.data_dir);
  try {
    const sessionKey = getString(p, "session");
    const jobs = store.listActive(sessionKey);
    section(`active cron jobs${sessionKey ? ` · ${sessionKey}` : ""}`);
    if (jobs.length === 0) {
      info("none.");
      return;
    }
    const rows = jobs.map((j) => [
      color.dim(j.id),
      classify(j.systemEvent),
      truncate(j.sessionKey, 36),
      schedule(j.schedule),
      new Date(j.nextFireMs).toLocaleString(),
      truncate(j.systemEvent, 60),
    ]);
    table(["id", "kind", "session", "schedule", "next", "event"], rows);
    print("");
    info(`${jobs.length} job(s)`);
  } finally {
    store.close();
  }
}

function remove(id: string | undefined): void {
  if (!id) {
    fail("missing job id (use `edmund cron list` to find one)");
    process.exit(2);
  }
  const cfg = loadConfig();
  const store = new CronStore(cfg.paths.data_dir);
  try {
    const didCancel = store.cancel(id);
    if (didCancel) ok(`canceled ${id}`);
    else fail(`no active job with id ${id}`);
  } finally {
    store.close();
  }
}

function cancelPokes(sessionKey: string | undefined): void {
  if (!sessionKey) {
    fail("missing session key");
    process.exit(2);
  }
  const cfg = loadConfig();
  const store = new CronStore(cfg.paths.data_dir);
  try {
    const n = store.cancelPokes(sessionKey);
    ok(`canceled ${n} poke job(s) for ${sessionKey}`);
  } finally {
    store.close();
  }
}

function classify(event: string): string {
  if (event.startsWith("Self-poke:")) return color.dim("poke");
  if (event.startsWith("[Retry")) return color.yellow("retry");
  if (event.startsWith("A sub-agent you spawned")) return color.green("agent");
  if (event.startsWith("An agent team has finished")) return color.green("team");
  return color.cyan("sched");
}

function schedule(s: unknown): string {
  const sched = s as { kind?: string; atMs?: number; expr?: string };
  if (sched.kind === "once" && sched.atMs) {
    return `once · ${new Date(sched.atMs).toLocaleTimeString()}`;
  }
  if (sched.kind === "cron" && sched.expr) return `cron · ${sched.expr}`;
  return JSON.stringify(s);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
