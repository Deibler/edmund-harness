import { Hono } from "hono";
import type { CronStore } from "../../../src/cron/store.ts";
import type { CronJob, JobSchedule } from "../../../src/cron/types.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { sessionLabel } from "../services/labels.ts";
import type { CronJobDto } from "../types.ts";

type Deps = { crons: CronStore; contacts: ContactBook; chatDb: ChatDb };

export function cronRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const sessionKey = c.req.query("sessionKey") || undefined;
    const rows = deps.crons.listActive(sessionKey);
    const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
    return c.json({ jobs: rows.map((j) => toDto(j, labelDeps)) });
  });

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      sessionKey?: string;
      systemEvent?: string;
      schedule?: JobSchedule;
    } | null;
    if (!body?.sessionKey || !body.systemEvent || !body.schedule) {
      return c.json({ error: "sessionKey, systemEvent, schedule required" }, 400);
    }
    try {
      const job = deps.crons.create({
        sessionKey: body.sessionKey,
        systemEvent: body.systemEvent,
        schedule: body.schedule,
      });
      const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };
      return c.json({ job: toDto(job, labelDeps) }, 201);
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
    }
  });

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const ok = deps.crons.cancel(id);
    if (!ok) return c.json({ error: "not found or already canceled" }, 404);
    return c.json({ ok: true });
  });

  app.post("/cancel-pokes", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionKey?: string } | null;
    if (!body?.sessionKey) return c.json({ error: "sessionKey required" }, 400);
    const n = deps.crons.cancelPokes(body.sessionKey);
    return c.json({ canceled: n });
  });

  return app;
}

function toDto(job: CronJob, deps: { contacts: ContactBook; chatDb: ChatDb }): CronJobDto {
  return {
    id: job.id,
    sessionKey: job.sessionKey,
    sessionLabel: sessionLabel(job.sessionKey, deps),
    systemEvent: job.systemEvent,
    schedule: job.schedule,
    scheduleSummary: summarize(job.schedule),
    kind: classify(job.systemEvent),
    nextFireMs: job.nextFireMs,
    createdAt: job.createdAt,
    lastFiredMs: job.lastFiredMs,
    status: job.status,
  };
}

function classify(event: string): CronJobDto["kind"] {
  if (event.startsWith("Self-poke:")) return "poke";
  if (event.startsWith("[Retry")) return "retry";
  if (event.startsWith("A sub-agent you spawned")) return "agent-done";
  if (event.startsWith("An agent team has finished")) return "team-done";
  return "scheduled";
}

function summarize(s: JobSchedule): string {
  if (s.kind === "once") {
    const d = new Date(s.atMs);
    return `once @ ${d.toLocaleString()}`;
  }
  return `cron "${s.expr}"${s.tz ? ` (${s.tz})` : ""}`;
}
