import { Hono } from "hono";
import type { AgentStore } from "../../../src/agents/store.ts";
import type { CronStore } from "../../../src/cron/store.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { status as daemonStatus } from "../services/daemonCtl.ts";
import { sessionLabel } from "../services/labels.ts";
import type { LogTail } from "../services/logTail.ts";
import type { ActivityEvent, OverviewSnapshot } from "../types.ts";

type Deps = {
  state: StateStore;
  crons: CronStore;
  agents: AgentStore;
  contacts: ContactBook;
  chatDb: ChatDb;
  tail: LogTail;
};

export function activityRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/overview", async (c) => {
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    const sessions = deps.state.listSessions();
    const activeAgents = deps.agents
      .list()
      .filter((a) => a.status === "running" || a.status === "pending");
    const stuckAgents = deps.agents.listStuck({
      pendingStaleMs: 60_000,
      runningStaleMs: 15 * 60 * 1000,
    });
    const since24h = Date.now() - 24 * 3600 * 1000;
    const agents24h = deps.agents.list().filter((a) => a.spawnedAt >= since24h);
    const activeCrons = deps.crons.listActive();
    const nextDue = deps.crons.nextDue();

    const oneHourAgo = Date.now() - 3600 * 1000;
    const recentLogs = deps.tail.snapshot(2000).filter((l) => l.ts >= oneHourAgo);
    const errorsLastHour = recentLogs.filter((l) => l.level === "error").length;

    const events: ActivityEvent[] = [];
    for (const s of sessions.slice(0, 8)) {
      if (s.lastInboundMs > 0) {
        events.push({
          kind: "inbound",
          ts: s.lastInboundMs,
          sessionKey: s.sessionKey,
          sessionLabel: sessionLabel(s.sessionKey, labelDeps),
          preview: "(last inbound)",
        });
      }
      if (s.lastOutboundMs > 0) {
        events.push({
          kind: "outbound",
          ts: s.lastOutboundMs,
          sessionKey: s.sessionKey,
          sessionLabel: sessionLabel(s.sessionKey, labelDeps),
          preview: "(last outbound)",
        });
      }
    }
    for (const a of agents24h.slice(0, 20)) {
      events.push({
        kind: "agent",
        ts: a.finishedAt ?? a.spawnedAt,
        sessionKey: a.parentSessionKey,
        sessionLabel: sessionLabel(a.parentSessionKey, labelDeps),
        agentId: a.id,
        status: a.status,
        taskPreview: a.task.replace(/\s+/g, " ").slice(0, 80),
      });
    }
    for (const job of activeCrons.slice(0, 15)) {
      events.push({
        kind: "cron",
        ts: job.nextFireMs,
        sessionKey: job.sessionKey,
        sessionLabel: sessionLabel(job.sessionKey, labelDeps),
        jobId: job.id,
        summary: job.systemEvent.slice(0, 80),
      });
    }
    events.sort((a, b) => b.ts - a.ts);

    const snap: OverviewSnapshot = {
      daemon: await daemonStatus(),
      sessions: {
        total: sessions.length,
        dms: sessions.filter((s) => !s.isGroup).length,
        groups: sessions.filter((s) => s.isGroup).length,
      },
      agents: { active: activeAgents.length, stuck: stuckAgents.length, last24h: agents24h.length },
      crons: { active: activeCrons.length, nextDueMs: nextDue?.nextFireMs ?? null },
      errorsLastHour,
      recent: events.slice(0, 40),
    };
    return c.json(snap);
  });

  return app;
}
