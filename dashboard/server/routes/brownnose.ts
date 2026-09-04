import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import type { CronStore } from "../../../src/cron/store.ts";
import { resolveIntensity } from "../../../src/ghost/intensity.ts";
import {
  DEFAULT_ACTIVE_HOURS_DM,
  DEFAULT_ACTIVE_HOURS_GROUP,
  type GhostPrefsStore,
  snoozeActive,
} from "../../../src/ghost/prefs.ts";
import { runGhostTick } from "../../../src/ghost/think.ts";
import { getGroupParticipants } from "../../../src/imessage/participants.ts";
import { sandboxDir } from "../../../src/persona/sandbox.ts";
import {
  BROWN_NOSE_PREFIX,
  decodeBrownNoseSystemEvent,
  enqueueBrownNoseFire,
  isBrownNoseEvent,
} from "../../../src/proactive/queue.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { SessionKey } from "../../../src/sessions/key.ts";
import { chatIdFromKey, isGroupSession } from "../../../src/sessions/key.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { sessionLabel } from "../services/labels.ts";

type Deps = {
  state: StateStore;
  prefs: GhostPrefsStore;
  contacts: ContactBook;
  chatDb: import("../../../src/imessage/db.ts").ChatDb;
  config: Config;
  crons: CronStore;
};

/**
 * /api/brownnose — full operator control over the proactive ghost.
 *
 *   GET  /              → every session: state, who's in it, last interaction,
 *                         snooze, fire counts
 *   GET  /:key          → verbose snapshot: prefs, stats, full decision log
 *                         (reasoning), fires w/ outcomes, ghost workspace
 *   POST /:key/enable
 *   POST /:key/disable        body: { reason }
 *   POST /:key/reset
 *   POST /:key/snooze/clear   → void a ghost-set snooze
 *   POST /:key/invoke         body: { force?, fireNow? } → run a REAL ghost
 *                             tick now (tool-using; can take minutes) and
 *                             enqueue the fire if it acts
 *
 * Same data model the CLI uses — both read/write the shared state.db
 * `brown_nose_prefs` + `brown_nose_fires` tables through GhostPrefsStore.
 */
export function brownnoseRoutes(deps: Deps): Hono {
  const app = new Hono();
  const labelDeps = { contacts: deps.contacts, chatDb: deps.chatDb };

  /** Group member display names (groups only). */
  const membersOf = (key: SessionKey): string[] => {
    if (!isGroupSession(key)) return [];
    try {
      return getGroupParticipants(deps.chatDb, chatIdFromKey(key)).map(
        (h) => deps.contacts.displayName(h) ?? h,
      );
    } catch {
      return [];
    }
  };

  app.get("/", (c) => {
    const sessions = deps.state.listSessions();
    const prefsByKey = new Map(deps.prefs.list().map((p) => [p.sessionKey, p]));
    const intensity = deps.config.brown_nose.intensity;
    const params = resolveIntensity(intensity);

    const weekMs = 7 * 86_400_000;
    const dayMs = 86_400_000;
    let weekFiresTotal = 0;
    let dayFiresTotal = 0;
    let enrolledCount = 0;
    let enabledCount = 0;
    const now = Date.now();
    const rows = sessions.map((s) => {
      const key = s.sessionKey as SessionKey;
      const pref = prefsByKey.get(key);
      const recent = pref ? deps.prefs.recentFires(key, 50) : [];
      const lastFire = recent[0];
      const wkCount = recent.filter((f) => now - f.firedAtMs < weekMs).length;
      const dayCount = recent.filter((f) => now - f.firedAtMs < dayMs).length;
      if (pref) enrolledCount++;
      if (pref?.enabled) enabledCount++;
      weekFiresTotal += wkCount;
      dayFiresTotal += dayCount;
      const snoozed = pref ? snoozeActive(pref, s.lastInboundMs ?? 0, now) : false;
      return {
        sessionKey: key,
        label: sessionLabel(key, labelDeps),
        isGroup: isGroupSession(key),
        members: membersOf(key),
        lastInboundMs: s.lastInboundMs || null,
        lastOutboundMs: s.lastOutboundMs || null,
        enrolled: pref !== undefined,
        enabled: pref?.enabled ?? false,
        disabledReason: pref?.disabledReason ?? null,
        snoozedUntilMs: snoozed ? (pref?.snoozeUntilMs ?? null) : null,
        weeklyCap: pref?.weeklyCap ?? null,
        cooldownMultiplier: pref?.cooldownMultiplier ?? null,
        timezone: pref?.timezone ?? null,
        activeHours: pref?.activeHours ?? [],
        focusSuggestionCount: pref?.focusSuggestions.length ?? 0,
        lastFireAtMs: lastFire?.firedAtMs ?? null,
        lastFireOutcome: lastFire?.outcome ?? null,
        firesThisWeek: wkCount,
        firesToday: dayCount,
      };
    });
    return c.json({
      sessions: rows,
      globals: {
        enabled: deps.config.brown_nose.enabled,
        intensity,
        intensityParams: params,
        dmsEnabledByDefault: deps.config.brown_nose.dms_enabled_by_default,
        groupsEnabledByDefault: deps.config.brown_nose.groups_enabled_by_default,
        maxConcurrentFires: deps.config.brown_nose.max_concurrent_fires,
      },
      budget: {
        enrolledCount,
        enabledCount,
        firesThisWeek: weekFiresTotal,
        firesToday: dayFiresTotal,
        maxGhostTicksPerDay: deps.config.brown_nose.max_ghost_ticks_per_day,
      },
    });
  });

  app.get("/:key", (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    const row = deps.prefs.get(key);
    const session = deps.state.getSession(key);
    const recentFires = row ? deps.prefs.recentFires(key, 30) : [];
    const decisions = readRecentDecisions(key, 100);
    const now = Date.now();

    // Decision-log stats: how is the ghost actually spending its ticks?
    const stats = {
      decisionsTotal: decisions.length,
      acts: 0,
      modelNos: 0,
      gateNos: 0,
      snoozesSet: 0,
      parseErrors: 0,
      firesByOutcome: { engaged: 0, ignored: 0, pushed_back: 0, pending: 0 } as Record<
        string,
        number
      >,
    };
    for (const d of decisions) {
      if (d.act) {
        stats.acts++;
        continue;
      }
      const reason = typeof d.reason === "string" ? d.reason : "";
      if (typeof d.snoozeUntilMs === "number") stats.snoozesSet++;
      if (reason.startsWith("parse error")) stats.parseErrors++;
      else if (d.gate || /^(cooldown|active_hours|enabled|weekly_cap|no prefs)/.test(reason))
        stats.gateNos++;
      else stats.modelNos++;
    }
    for (const f of recentFires) {
      stats.firesByOutcome[f.outcome ?? "pending"] =
        (stats.firesByOutcome[f.outcome ?? "pending"] ?? 0) + 1;
    }

    return c.json({
      sessionKey: key,
      label: sessionLabel(key, labelDeps),
      isGroup: isGroupSession(key),
      handle: chatIdFromKey(key),
      members: membersOf(key),
      lastInboundMs: session?.lastInboundMs || null,
      lastOutboundMs: session?.lastOutboundMs || null,
      prefs: row
        ? {
            enabled: row.enabled,
            disabledReason: row.disabledReason,
            disabledAtMs: row.disabledAtMs,
            weeklyCap: row.weeklyCap,
            cooldownMultiplier: row.cooldownMultiplier,
            timezone: row.timezone,
            activeHours: row.activeHours,
            focusSuggestions: row.focusSuggestions,
            snoozeUntilMs: row.snoozeUntilMs,
            snoozeSetAtMs: row.snoozeSetAtMs,
            snoozeActive: snoozeActive(row, session?.lastInboundMs ?? 0, now),
            updatedAtMs: row.updatedAtMs,
          }
        : null,
      stats,
      queued: queuedFires(deps.crons, key),
      recentFires,
      decisions,
      workspace: readWorkspace(key),
    });
  });

  // ── queued-fire management ──────────────────────────────────────────
  // A queued fire is a once-cron carrying a [BROWN_NOSE] payload. The
  // operator can kill it or move its fire time before it goes out.

  const ownedBrownNoseJob = (key: SessionKey, jobId: string) => {
    const job = deps.crons.get(jobId);
    if (!job || job.sessionKey !== key || !isBrownNoseEvent(job.systemEvent)) return null;
    return job;
  };

  app.post("/:key/queued/:jobId/cancel", (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    const job = ownedBrownNoseJob(key, c.req.param("jobId"));
    if (!job) return c.json({ error: "no such queued fire" }, 404);
    return c.json({ ok: deps.crons.cancel(job.id) });
  });

  app.post("/:key/queued/:jobId/reschedule", async (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    const job = ownedBrownNoseJob(key, c.req.param("jobId"));
    if (!job) return c.json({ error: "no such queued fire" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const atMs = typeof body?.atMs === "number" ? Math.round(body.atMs) : Number.NaN;
    if (!Number.isFinite(atMs) || atMs < Date.now() - 60_000) {
      return c.json({ error: "atMs must be a future unix-ms timestamp" }, 400);
    }
    // Keep the payload's expiry ahead of the new fire time — otherwise the
    // moved job would drop itself as expired the moment it fires.
    const payload = decodeBrownNoseSystemEvent(job.systemEvent);
    let systemEvent: string | undefined;
    if (payload && payload.expiresAtMs <= atMs) {
      systemEvent = `${BROWN_NOSE_PREFIX}${JSON.stringify({ ...payload, expiresAtMs: atMs + 6 * 3_600_000 })}`;
    }
    const updated = deps.crons.update(job.id, {
      schedule: { kind: "once", atMs },
      ...(systemEvent ? { systemEvent } : {}),
    });
    if (!updated) return c.json({ error: "job is no longer active" }, 409);
    return c.json({ ok: true, nextFireMs: updated.nextFireMs, expiryExtended: !!systemEvent });
  });

  // ── active hours ────────────────────────────────────────────────────
  app.post("/:key/hours", async (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    const body = await c.req.json().catch(() => ({}));
    const hours = parseActiveHours(body?.activeHours);
    if (hours === null) return c.json({ error: "invalid activeHours" }, 400);
    const update: Record<string, unknown> = { activeHours: hours };
    if (typeof body?.timezone === "string" && body.timezone.length > 0) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
        update.timezone = body.timezone;
      } catch {
        return c.json({ error: "invalid timezone" }, 400);
      }
    }
    deps.prefs.upsert(key, { ...update, defaultsIfNew: defaultsFromConfig(deps.config, key) });
    return c.json({ ok: true, activeHours: hours });
  });

  app.post("/:key/enable", (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    deps.prefs.upsert(key, {
      enabled: true,
      disabledReason: null,
      disabledAtMs: null,
      defaultsIfNew: defaultsFromConfig(deps.config, key),
    });
    return c.json({ ok: true });
  });

  app.post("/:key/disable", async (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    const body = await c.req.json().catch(() => ({}));
    const reason =
      typeof body?.reason === "string" && body.reason.length > 0 ? body.reason : "dashboard";
    deps.prefs.upsert(key, {
      enabled: false,
      disabledReason: reason,
      disabledAtMs: Date.now(),
      defaultsIfNew: defaultsFromConfig(deps.config, key),
    });
    return c.json({ ok: true, reason });
  });

  app.post("/:key/reset", (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    deps.prefs.remove(key);
    return c.json({ ok: true });
  });

  app.post("/:key/snooze/clear", (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    deps.prefs.setSnooze(key, null);
    return c.json({ ok: true });
  });

  // Force a brown-nose: run a REAL tool-using ghost tick right now. The
  // tick can take minutes (it researches + stages work); the request is
  // held open and returns the decision + enqueue result. With fireNow the
  // fire is queued without jitter so it goes out as soon as the daemon's
  // scheduler picks it up.
  app.post("/:key/invoke", async (c) => {
    const key = decodeURIComponent(c.req.param("key")) as SessionKey;
    const body = await c.req.json().catch(() => ({}));
    const force = body?.force !== false; // dashboard default: bypass budgets
    const fireNow = body?.fireNow === true;

    // Enroll on first touch so "invoke" works on any session row.
    if (!deps.prefs.get(key)) {
      deps.prefs.upsert(key, { defaultsIfNew: defaultsFromConfig(deps.config, key) });
    }

    const decision = await runGhostTick(
      { sessionKey: key, bypassActiveHours: true, bypassBudgets: force },
      {
        config: deps.config,
        chatDb: deps.chatDb,
        contacts: deps.contacts,
        prefs: deps.prefs,
      },
    );

    if (!decision.act) {
      if (decision.snoozeUntilMs) deps.prefs.setSnooze(key, decision.snoozeUntilMs);
      return c.json({ decision });
    }
    const res = enqueueBrownNoseFire({
      sessionKey: key,
      decision,
      config: deps.config,
      crons: deps.crons,
      sessionPrefs: deps.prefs.get(key),
      prefsStore: deps.prefs,
      noJitter: fireNow,
    });
    return c.json({ decision, enqueue: res });
  });

  return app;
}

/** Pending [BROWN_NOSE] once-jobs for a session, decoded for the UI. */
function queuedFires(crons: CronStore, key: SessionKey) {
  return crons
    .listActive(key)
    .filter((j) => isBrownNoseEvent(j.systemEvent))
    .map((j) => {
      const payload = decodeBrownNoseSystemEvent(j.systemEvent);
      return {
        jobId: j.id,
        nextFireMs: j.nextFireMs,
        createdAt: j.createdAt,
        brief: payload?.brief ?? "(unreadable payload)",
        tags: payload?.tags ?? [],
        expiresAtMs: payload?.expiresAtMs ?? null,
        confidence: payload?.confidence ?? null,
      };
    });
}

const DOWS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const HHMM = /^\d{1,2}:\d{2}$/;

function parseActiveHours(raw: unknown): Array<{
  dow: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  start: string;
  end: string;
}> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ dow: never; start: string; end: string }> = [];
  for (const w of raw.slice(0, 14)) {
    if (!w || typeof w !== "object") return null;
    const { dow, start, end } = w as Record<string, unknown>;
    if (typeof dow !== "string" || !DOWS.has(dow)) return null;
    if (typeof start !== "string" || !HHMM.test(start)) return null;
    if (typeof end !== "string" || !HHMM.test(end)) return null;
    out.push({ dow: dow as never, start, end });
  }
  return out;
}

function defaultsFromConfig(config: Config, sessionKey: SessionKey) {
  const isGroup = isGroupSession(sessionKey);
  const params = resolveIntensity(config.brown_nose.intensity);
  return {
    enabled: isGroup
      ? config.brown_nose.groups_enabled_by_default
      : config.brown_nose.dms_enabled_by_default,
    activeHours: isGroup ? DEFAULT_ACTIVE_HOURS_GROUP : DEFAULT_ACTIVE_HOURS_DM,
    timezone: config.brown_nose.default_timezone,
    weeklyCap: params.weeklyCap,
  };
}

/** Loose decision shape — the log has evolved (gates, snoozes, contextFiles);
 *  pass everything through and let the UI render what's there. */
type StoredDecision = {
  act: boolean;
  tickAtMs: number;
  reason?: string;
  gate?: unknown;
  snoozeUntilMs?: number;
  fireAtMs?: number;
  brief?: string;
  tags?: string[];
  expiresAtMs?: number;
  confidence?: string;
  contextFiles?: string[];
};

function readRecentDecisions(sessionKey: SessionKey, limit: number): StoredDecision[] {
  const path = join(sandboxDir(sessionKey), "brownnose", "decisions.jsonl");
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    const out: StoredDecision[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as StoredDecision);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/** Ghost workspace snapshot: running notes + staged drafts/research. */
function readWorkspace(sessionKey: SessionKey): {
  currentNotes: string | null;
  files: Array<{ path: string; rel: string; sizeBytes: number; modifiedAtMs: number }>;
} {
  const dir = join(sandboxDir(sessionKey), "brownnose");
  let currentNotes: string | null = null;
  const notesPath = join(dir, "current.md");
  if (existsSync(notesPath)) {
    try {
      currentNotes = readFileSync(notesPath, "utf8").slice(0, 8_000) || null;
    } catch {}
  }
  const files: Array<{ path: string; rel: string; sizeBytes: number; modifiedAtMs: number }> = [];
  for (const sub of ["drafts", "research"]) {
    const subDir = join(dir, sub);
    if (!existsSync(subDir)) continue;
    try {
      for (const name of readdirSync(subDir)) {
        const p = join(subDir, name);
        const st = statSync(p);
        if (!st.isFile()) continue;
        files.push({
          path: p,
          rel: `${sub}/${name}`,
          sizeBytes: st.size,
          modifiedAtMs: st.mtimeMs,
        });
      }
    } catch {}
  }
  files.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return { currentNotes, files };
}
