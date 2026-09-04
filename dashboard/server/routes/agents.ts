import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AgentStore } from "../../../src/agents/store.ts";
import type { Agent } from "../../../src/agents/types.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { sessionLabel } from "../services/labels.ts";
import type { AgentDto } from "../types.ts";

type Deps = { agents: AgentStore; contacts: ContactBook; chatDb: ChatDb };

export function agentsRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const status = c.req.query("status") as Agent["status"] | undefined;
    const sessionKey = c.req.query("sessionKey") || undefined;
    const teamId = c.req.query("teamId") || undefined;
    const rows = deps.agents.list({ parentSessionKey: sessionKey, status, teamId });
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    return c.json({ agents: rows.map((a) => toDto(a, labelDeps)) });
  });

  app.get("/:id", (c) => {
    const row = deps.agents.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    return c.json({ agent: toDto(row, labelDeps) });
  });

  app.get("/:id/result", (c) => {
    const row = deps.agents.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const text = existsSync(row.resultPath) ? readFileSync(row.resultPath, "utf8") : "";
    return c.json({ text });
  });

  app.get("/:id/log", (c) => {
    const row = deps.agents.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const tailLines = Number.parseInt(c.req.query("tail") || "500", 10);
    const text = existsSync(row.logPath) ? readFileSync(row.logPath, "utf8") : "";
    const lines = text.split("\n");
    return c.json({ text: lines.slice(-tailLines).join("\n") });
  });

  app.post("/:id/cancel", (c) => {
    const row = deps.agents.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.pid !== null) {
      try {
        process.kill(row.pid, "SIGTERM");
      } catch {}
    }
    if (row.status === "pending" || row.status === "running") {
      deps.agents.finish(row.id, "canceled", -1);
    }
    return c.json({ ok: true });
  });

  return app;
}

function toDto(agent: Agent, deps: { contacts: ContactBook; chatDb: ChatDb }): AgentDto {
  return {
    id: agent.id,
    parentSessionKey: agent.parentSessionKey,
    parentSessionLabel: sessionLabel(agent.parentSessionKey, deps),
    task: agent.task,
    taskPreview: agent.task.replace(/\s+/g, " ").trim().slice(0, 160),
    status: agent.status,
    pid: agent.pid,
    spawnedAt: agent.spawnedAt,
    finishedAt: agent.finishedAt,
    exitCode: agent.exitCode,
    teamId: agent.teamId,
    role: agent.role,
    deliveredAt: agent.deliveredAt,
    sandboxPath: agent.sandboxPath,
    resultPath: agent.resultPath,
    logPath: agent.logPath,
  };
}
