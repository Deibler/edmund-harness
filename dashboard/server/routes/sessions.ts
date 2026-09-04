import { Hono } from "hono";
import type { AgentStore } from "../../../src/agents/store.ts";
import type { CronStore } from "../../../src/cron/store.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { isGroupSession } from "../../../src/sessions/key.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { sessionLabel } from "../services/labels.ts";
import type { SessionSummary } from "../types.ts";

type Deps = {
  state: StateStore;
  crons: CronStore;
  agents: AgentStore;
  contacts: ContactBook;
  chatDb: ChatDb;
};

export function sessionsRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = deps.state.listSessions();
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    const summaries: SessionSummary[] = rows.map((r) => ({
      sessionKey: r.sessionKey,
      label: sessionLabel(r.sessionKey, labelDeps),
      isGroup: isGroupSession(r.sessionKey),
      chatGuid: r.chatGuid || null,
      claudeSessionId: r.claudeSessionId,
      lastInboundMs: r.lastInboundMs,
      lastOutboundMs: r.lastOutboundMs,
      createdAt: r.createdAt,
      activeCrons: deps.crons.listActive(r.sessionKey).length,
      activeAgents: deps.agents
        .list({ parentSessionKey: r.sessionKey })
        .filter((a) => a.status === "running" || a.status === "pending").length,
    }));
    return c.json({ sessions: summaries });
  });

  app.get("/:key", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const rec = deps.state.getSession(key);
    if (!rec) return c.json({ error: "not found" }, 404);
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    return c.json({
      session: {
        sessionKey: rec.sessionKey,
        label: sessionLabel(rec.sessionKey, labelDeps),
        isGroup: isGroupSession(rec.sessionKey),
        chatGuid: rec.chatGuid || null,
        claudeSessionId: rec.claudeSessionId,
        lastInboundMs: rec.lastInboundMs,
        lastOutboundMs: rec.lastOutboundMs,
        createdAt: rec.createdAt,
        activeCrons: deps.crons.listActive(rec.sessionKey).length,
        activeAgents: deps.agents
          .list({ parentSessionKey: rec.sessionKey })
          .filter((a) => a.status === "running" || a.status === "pending").length,
      },
    });
  });

  app.post("/:key/reset", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const rec = deps.state.getSession(key);
    if (!rec) return c.json({ error: "not found" }, 404);
    deps.state.setClaudeSessionId(key, null);
    return c.json({ ok: true });
  });

  return app;
}
