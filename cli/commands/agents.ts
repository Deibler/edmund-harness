/**
 * `edmund agents list [--status <status>] [--session <key>]`
 * `edmund agents cancel <id>`
 */

import { AgentStore } from "../../src/agents/store.ts";
import type { AgentStatus } from "../../src/agents/types.ts";
import { loadConfig } from "../../src/config/config.ts";
import type { Parsed } from "../args.ts";
import { getString } from "../args.ts";
import { color, fail, info, ok, print, section, table } from "../ui.ts";

const STATUS_COLOR: Record<AgentStatus, (s: string) => string> = {
  pending: color.dim,
  running: color.cyan,
  done: color.green,
  failed: color.red,
  canceled: color.yellow,
};

function rel(ms: number | null): string {
  if (!ms) return color.dim("—");
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  return `${Math.round(d / 3_600_000)}h`;
}

export async function agentsCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0] ?? "list";
  const cfg = loadConfig();
  const store = new AgentStore(cfg.paths.data_dir);

  if (sub === "list" || sub === "ls") {
    const status = getString(p, "status") as AgentStatus | undefined;
    const sessionKey = getString(p, "session");
    const rows = store.list({ status, parentSessionKey: sessionKey });
    section(`agents${status ? ` · ${status}` : ""}${sessionKey ? ` · ${sessionKey}` : ""}`);
    if (rows.length === 0) {
      info("none.");
      return;
    }
    const data = rows
      .slice(0, 50)
      .map((a) => [
        color.dim(a.id.slice(0, 22)),
        STATUS_COLOR[a.status](a.status),
        a.role ? color.dim(a.role) : "",
        `${rel(a.spawnedAt)} ago`,
        a.finishedAt ? `${rel(a.finishedAt)} ago` : color.dim("—"),
        truncate(a.task.replace(/\s+/g, " "), 60),
      ]);
    table(["id", "status", "role", "spawned", "finished", "task"], data);
    print("");
    info(`${rows.length} agent(s)${rows.length > 50 ? " (showing 50)" : ""}`);
    return;
  }

  if (sub === "cancel") {
    const id = p.positional[1];
    if (!id) {
      fail("missing agent id");
      process.exit(2);
    }
    const agent = store.get(id);
    if (!agent) {
      fail("no such agent");
      process.exit(1);
    }
    if (agent.pid) {
      try {
        process.kill(agent.pid, "SIGTERM");
      } catch {}
    }
    if (agent.status === "pending" || agent.status === "running") {
      store.finish(id, "canceled", -1);
    }
    ok(`canceled ${id}`);
    return;
  }

  fail(`unknown agents subcommand: ${sub}`);
  info("usage: edmund agents [list | cancel <id>]");
  process.exit(2);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
