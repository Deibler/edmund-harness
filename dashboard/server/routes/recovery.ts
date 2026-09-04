import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { sessionLabel } from "../services/labels.ts";
import type { RecoveryRowDto } from "../types.ts";

export function recoveryRoutes(deps: {
  state: StateStore;
  contacts: ContactBook;
  chatDb: ChatDb;
  config: Config;
}): Hono {
  const app = new Hono();
  const kickPath = resolve(deps.config.paths.data_dir, "recovery-sweep.kick");
  const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };

  app.get("/", (c) => {
    const now = Date.now();
    const staleAfter = now - deps.config.recovery.stale_threshold_seconds * 1000;
    const candidates = deps.state.listSessionsNeedingRecovery(staleAfter);
    const cooldownMs = deps.config.recovery.cooldown_minutes * 60_000;
    const rows: RecoveryRowDto[] = candidates.map((s) => ({
      sessionKey: s.sessionKey,
      label: sessionLabel(s.sessionKey, labelDeps),
      lastInboundMs: s.lastInboundMs || null,
      lastOutboundMs: s.lastOutboundMs || null,
      stuckSeconds: Math.round((now - s.lastInboundMs) / 1000),
      healFailures: s.healAttemptsCount,
      lastErrorText: s.lastErrorClass,
      cooldownUntilMs: s.lastRecoveryAttemptMs > 0 ? s.lastRecoveryAttemptMs + cooldownMs : null,
    }));
    return c.json({
      rows,
      config: deps.config.recovery,
      sweepKicked: existsSync(kickPath),
    });
  });

  app.post("/sweep", (c) => {
    writeFileSync(kickPath, String(Date.now()));
    return c.json({ kicked: true });
  });

  app.post("/:sessionKey/reset", (c) => {
    const key = decodeURIComponent(c.req.param("sessionKey"));
    deps.state.clearError(key);
    return c.json({ reset: true });
  });

  return app;
}
