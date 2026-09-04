import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import type { SessionKey } from "../sessions/key.ts";

/**
 * Persistent store for brown-nose mode state. Two tables, both in
 * state.db so the daemon and CLI share one source of truth:
 *
 *   brown_nose_prefs   — one row per session: enabled, active hours,
 *                        timezone, cap, focus suggestions, disable
 *                        reason if any.
 *
 *   brown_nose_fires   — append-only log of every fire that actually
 *                        invoked the main model. Drives the weekly-cap
 *                        check and engagement-decay logic. Outcome is
 *                        backfilled after the user responds (or not).
 *
 * Migrations use CREATE TABLE IF NOT EXISTS so daemon startup,
 * standalone CLI use, and the existing StateStore migration in
 * src/sessions/store.ts can all call .migrate() safely. (The session
 * store doesn't touch these tables — that keeps the two stores
 * decoupled.)
 */

export type ActiveHoursWindow = {
  /** Three-letter lowercase: mon, tue, wed, thu, fri, sat, sun. */
  dow: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  /** Local time in HH:MM, 24-hour. */
  start: string;
  end: string;
};

export type FocusSuggestion = {
  topic: string;
  /** Times the ghost has acted on this suggestion in the current week.
   *  Incremented by recordFocusUsage on DELIVERED fires whose tags match
   *  the topic; reset when the week window rolls. */
  usageCount: number;
  /** Start of the usage week `usageCount` counts against. Absent on rows
   *  written before the counter worked — treated as "no window yet". */
  weekStartMs?: number;
  /** When this suggestion expires (unix ms). null = never. */
  expiresAtMs: number | null;
  createdAtMs: number;
};

/** Case-insensitive match between a fire's telemetry tags and a focus
 *  topic — substring either way, so tag "fishing-report" hits topic
 *  "fishing" and tag "training" hits topic "my training". */
function tagsMatchTopic(tags: string[], topic: string): boolean {
  const t = topic.toLowerCase();
  return tags.some((tag) => {
    const g = tag.toLowerCase();
    return g.includes(t) || t.includes(g);
  });
}

export type BrownNosePrefs = {
  sessionKey: SessionKey;
  enabled: boolean;
  activeHours: ActiveHoursWindow[];
  timezone: string;
  weeklyCap: number;
  /** Cooldown multiplier from engagement decay. 1.0 = normal,
   *  2.0 = doubled after one negative outcome, 3.0 after two, etc. */
  cooldownMultiplier: number;
  focusSuggestions: FocusSuggestion[];
  disabledReason: string | null;
  disabledAtMs: number | null;
  /** Ghost-set snooze: don't tick this session again until this instant.
   *  ALWAYS broken early by a user inbound newer than snoozeSetAtMs — the
   *  snooze means "nothing will change until they act", so them acting
   *  voids it. null = no snooze. */
  snoozeUntilMs: number | null;
  snoozeSetAtMs: number | null;
  /** Free-text note the USER wrote on their self-service portal — their
   *  own words about what proactive contact they want (or don't). Fed to
   *  the ghost verbatim every tick. */
  userNote: string | null;
  updatedAtMs: number;
};

/**
 * engaged / ignored — stamped by the deterministic backfill sweep from
 *   the user's observable behavior after a DELIVERED message.
 * reacted — no text reply, but the user TAPBACKED a bot message inside
 *   the engagement window; `reactionGlyph` carries which one. Polarity
 *   matters: ❤️/👍/😂/‼️ read as "that landed", 👎 as push-back-lite,
 *   ❓ as confusion. Stamped by the same sweep.
 * pushed_back — stamped by the disable_brown_nose handler (judgment call).
 * vetoed — main's KEEP_QUIET killed the brief; NO message reached the
 *   user, so this must never be scored from user behavior. (Before this
 *   existed, vetoed fires sat outcome=NULL and the sweep stamped
 *   engaged/ignored from unrelated messages — 10/35 of all outcomes were
 *   phantom, 6 falsely "engaged".)
 * error — the fire's main run or delivery failed; infrastructure, not
 *   user disinterest.
 */
export type FireOutcome = "engaged" | "reacted" | "ignored" | "pushed_back" | "vetoed" | "error";

export type FireRecord = {
  id: number;
  sessionKey: SessionKey;
  firedAtMs: number;
  brief: string;
  tags: string[];
  outcome: FireOutcome | null;
  outcomeAtMs: number | null;
  /** Tapback glyph when outcome === "reacted" ("❤️", "👍", "👎", …). */
  reactionGlyph: string | null;
  /** True once the message actually reached the wire. Legacy rows
   *  (pre-column) read as delivered. */
  delivered: boolean;
};

/** The original default (M-F 9am-7pm). Kept only so the migration can
 *  recognize rows still on it and widen them — it excluded weekends and
 *  evenings entirely, which silently gated out most natural texting hours
 *  (a Saturday-afternoon or weekday-evening ping was always "outside
 *  active hours", and the ghost never got to decide). */
const LEGACY_ACTIVE_HOURS_DM: ActiveHoursWindow[] = [
  { dow: "mon", start: "09:00", end: "19:00" },
  { dow: "tue", start: "09:00", end: "19:00" },
  { dow: "wed", start: "09:00", end: "19:00" },
  { dow: "thu", start: "09:00", end: "19:00" },
  { dow: "fri", start: "09:00", end: "19:00" },
];

/** Default windows for a freshly-enrolled DM: every day, into the evening.
 *  9pm cutoff keeps late-night pings off the table; weekends start later. */
export const DEFAULT_ACTIVE_HOURS_DM: ActiveHoursWindow[] = [
  { dow: "mon", start: "09:00", end: "21:00" },
  { dow: "tue", start: "09:00", end: "21:00" },
  { dow: "wed", start: "09:00", end: "21:00" },
  { dow: "thu", start: "09:00", end: "21:00" },
  { dow: "fri", start: "09:00", end: "21:00" },
  { dow: "sat", start: "10:00", end: "21:00" },
  { dow: "sun", start: "10:00", end: "21:00" },
];

/** Group default windows. Groups USED to default to no windows at all
 *  ("forces a deliberate set_brown_nose call"), but in practice nobody
 *  ever set them — all 24 enrolled groups sat at `[]`, which the
 *  active-hours gate reads as BLOCKED, so no group could ever fire
 *  organically and forced fires died at fire time. Groups skew social /
 *  evening, so the window runs later than DMs. `[]` still means "never
 *  initiate" when a user deliberately turns every day off in the portal. */
export const DEFAULT_ACTIVE_HOURS_GROUP: ActiveHoursWindow[] = [
  { dow: "mon", start: "10:00", end: "23:00" },
  { dow: "tue", start: "10:00", end: "23:00" },
  { dow: "wed", start: "10:00", end: "23:00" },
  { dow: "thu", start: "10:00", end: "23:00" },
  { dow: "fri", start: "10:00", end: "23:00" },
  { dow: "sat", start: "10:00", end: "23:00" },
  { dow: "sun", start: "10:00", end: "23:00" },
];

type PrefsRow = {
  session_key: string;
  enabled: number;
  active_hours_json: string;
  timezone: string;
  weekly_cap: number;
  cooldown_multiplier: number;
  focus_suggestions_json: string;
  disabled_reason: string | null;
  disabled_at_ms: number | null;
  snooze_until_ms: number | null;
  snooze_set_at_ms: number | null;
  user_note: string | null;
  updated_at_ms: number;
};

type FireRow = {
  id: number;
  session_key: string;
  fired_at_ms: number;
  brief: string;
  tags_json: string;
  outcome: string | null;
  outcome_at_ms: number | null;
  reaction_glyph: string | null;
  delivered: number | null;
};

export class GhostPrefsStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "state.db"));
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brown_nose_prefs (
        session_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        active_hours_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        weekly_cap INTEGER NOT NULL,
        cooldown_multiplier REAL NOT NULL DEFAULT 1.0,
        focus_suggestions_json TEXT NOT NULL DEFAULT '[]',
        disabled_reason TEXT,
        disabled_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS brown_nose_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        fired_at_ms INTEGER NOT NULL,
        brief TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        outcome TEXT,
        outcome_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_bn_fires_session
        ON brown_nose_fires(session_key, fired_at_ms DESC);
    `);
    // Widen rows still on the legacy M-F 9-19 default to the current
    // default (evenings + weekends). Exact-match only — a row the operator
    // customized via set_brown_nose has different JSON and is untouched.
    this.db
      .query("UPDATE brown_nose_prefs SET active_hours_json = ? WHERE active_hours_json = ?")
      .run(JSON.stringify(DEFAULT_ACTIVE_HOURS_DM), JSON.stringify(LEGACY_ACTIVE_HOURS_DM));
    // Ghost-set snooze columns + portal user note (additive; NULL = unset).
    for (const col of ["snooze_until_ms INTEGER", "snooze_set_at_ms INTEGER", "user_note TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE brown_nose_prefs ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
    // Delivery flag on fires (additive; NULL = legacy row, read as delivered).
    // New fires start 0 and flip to 1 only when the message reaches the
    // wire — so KEEP_QUIET vetoes and failed runs can never be scored from
    // user behavior by the outcome sweep.
    try {
      this.db.exec("ALTER TABLE brown_nose_fires ADD COLUMN delivered INTEGER");
    } catch {
      // column already exists
    }
    // Tapback glyph for the Phase-5 "reacted" outcome (additive; NULL for
    // every other outcome class).
    try {
      this.db.exec("ALTER TABLE brown_nose_fires ADD COLUMN reaction_glyph TEXT");
    } catch {
      // column already exists
    }
    // ONE-TIME backfill: group rows enrolled under the old "no windows"
    // default all sat at [] — which the gates read as blocked, so groups
    // could never fire. Flag-guarded so a user who later deliberately
    // turns every day off in their portal isn't re-defaulted on restart.
    this.db.exec("CREATE TABLE IF NOT EXISTS bn_meta (key TEXT PRIMARY KEY, value TEXT)");
    const backfilled = this.db
      .query("SELECT value FROM bn_meta WHERE key = 'group_hours_backfill_v1'")
      .get();
    if (!backfilled) {
      const res = this.db
        .query(
          "UPDATE brown_nose_prefs SET active_hours_json = ? WHERE session_key LIKE 'imessage:group:%' AND active_hours_json = '[]'",
        )
        .run(JSON.stringify(DEFAULT_ACTIVE_HOURS_GROUP));
      this.db
        .query("INSERT INTO bn_meta(key, value) VALUES ('group_hours_backfill_v1', ?)")
        .run(String(res.changes ?? 0));
    }
    // Trading sessions have their own scheduled cadence (hourly cron +
    // price triggers) — the proactive ghost watching them just burns
    // ticks deciding whether to brown-nose a bot channel. Disable any
    // enrolled trading rows; the observer also refuses to (re)enroll them.
    this.db
      .query(
        `UPDATE brown_nose_prefs SET enabled = 0, disabled_reason = ?
         WHERE session_key LIKE 'trading:%' AND enabled = 1`,
      )
      .run("trading session — has its own scheduled cadence, ghost excluded");
    // Same for named-orchestrator sessions: the ghost speaks as the main
    // persona and must never act on (or read) another orchestrator's thread.
    this.db
      .query(
        `UPDATE brown_nose_prefs SET enabled = 0, disabled_reason = ?
         WHERE session_key LIKE 'orch:%' AND enabled = 1`,
      )
      .run("named-orchestrator session — ghost is main-persona only");
  }

  /**
   * Re-stamp weekly caps after an operator intensity change. Rows whose
   * cap still equals SOME intensity level's default (i.e. were never
   * hand-customized to a non-default value) move to the current
   * intensity's cap. A cap the operator set via set_brown_nose that
   * happens to collide with a table default gets restamped too — accepted:
   * changing global intensity is an explicit operator act and SHOULD win.
   * Returns the number of rows updated.
   */
  syncWeeklyCapsToIntensity(intensityDefaults: number[], currentCap: number): number {
    const placeholders = intensityDefaults.map(() => "?").join(",");
    const res = this.db
      .query(
        `UPDATE brown_nose_prefs SET weekly_cap = ?, updated_at_ms = ?
         WHERE weekly_cap != ? AND weekly_cap IN (${placeholders})`,
      )
      .run(currentCap, Date.now(), currentCap, ...intensityDefaults);
    return res.changes;
  }

  /** Set or clear the user's portal note for a session. */
  setUserNote(sessionKey: SessionKey, note: string | null): void {
    this.db
      .query("UPDATE brown_nose_prefs SET user_note = ?, updated_at_ms = ? WHERE session_key = ?")
      .run(
        note && note.trim().length > 0 ? note.trim().slice(0, 2000) : null,
        Date.now(),
        sessionKey,
      );
  }

  /** Set or clear the ghost snooze for a session. */
  setSnooze(sessionKey: SessionKey, untilMs: number | null, nowMs = Date.now()): void {
    this.db
      .query(
        `UPDATE brown_nose_prefs SET snooze_until_ms = ?, snooze_set_at_ms = ?, updated_at_ms = ?
         WHERE session_key = ?`,
      )
      .run(untilMs, untilMs === null ? null : nowMs, nowMs, sessionKey);
  }

  get(sessionKey: SessionKey): BrownNosePrefs | null {
    const row = this.db
      .query<PrefsRow, [string]>("SELECT * FROM brown_nose_prefs WHERE session_key = ?")
      .get(sessionKey);
    return row ? rowToPrefs(row) : null;
  }

  /**
   * A proactive message was DELIVERED carrying these telemetry tags —
   * bump usage on every matching focus suggestion, rolling the weekly
   * window as needed. This is the increment the 3-per-week cap promised
   * users always assumed existed (usageCount was read in four places and
   * written in none, so the cap and its OVERUSED prompt block were dead
   * code). Returns how many suggestions were bumped.
   */
  recordFocusUsage(sessionKey: SessionKey, tags: string[], nowMs = Date.now()): number {
    if (tags.length === 0) return 0;
    const prefs = this.get(sessionKey);
    if (!prefs || prefs.focusSuggestions.length === 0) return 0;
    const WEEK_MS = 7 * 86_400_000;
    let bumped = 0;
    let changed = false;
    const next = prefs.focusSuggestions.map((s) => {
      let usageCount = s.usageCount;
      let weekStartMs = s.weekStartMs;
      if (weekStartMs === undefined || nowMs - weekStartMs >= WEEK_MS) {
        if (usageCount !== 0 || weekStartMs === undefined) changed = true;
        usageCount = 0;
        weekStartMs = nowMs;
      }
      if (tagsMatchTopic(tags, s.topic)) {
        usageCount += 1;
        bumped++;
        changed = true;
      }
      return { ...s, usageCount, weekStartMs };
    });
    if (changed) this.upsert(sessionKey, { focusSuggestions: next });
    return bumped;
  }

  /** Insert if missing, otherwise update only the provided fields.
   *  `updatedAtMs` is always stamped to now(). */
  upsert(
    sessionKey: SessionKey,
    partial: Partial<Omit<BrownNosePrefs, "sessionKey" | "updatedAtMs">> & {
      /** When creating a new row, you must supply these defaults. They're
       *  ignored on update. */
      defaultsIfNew?: {
        activeHours: ActiveHoursWindow[];
        timezone: string;
        weeklyCap: number;
        enabled: boolean;
      };
    },
  ): BrownNosePrefs {
    const existing = this.get(sessionKey);
    if (!existing) {
      const d = partial.defaultsIfNew;
      if (!d) {
        throw new Error(
          `brown_nose_prefs: upsert without defaultsIfNew for new session ${sessionKey}`,
        );
      }
      const row: BrownNosePrefs = {
        sessionKey,
        enabled: partial.enabled ?? d.enabled,
        activeHours: partial.activeHours ?? d.activeHours,
        timezone: partial.timezone ?? d.timezone,
        weeklyCap: partial.weeklyCap ?? d.weeklyCap,
        cooldownMultiplier: partial.cooldownMultiplier ?? 1.0,
        focusSuggestions: partial.focusSuggestions ?? [],
        disabledReason: partial.disabledReason ?? null,
        disabledAtMs: partial.disabledAtMs ?? null,
        snoozeUntilMs: null,
        snoozeSetAtMs: null,
        userNote: null,
        updatedAtMs: Date.now(),
      };
      this.db
        .query(
          `INSERT INTO brown_nose_prefs
           (session_key, enabled, active_hours_json, timezone, weekly_cap,
            cooldown_multiplier, focus_suggestions_json,
            disabled_reason, disabled_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionKey,
          row.enabled ? 1 : 0,
          JSON.stringify(row.activeHours),
          row.timezone,
          row.weeklyCap,
          row.cooldownMultiplier,
          JSON.stringify(row.focusSuggestions),
          row.disabledReason,
          row.disabledAtMs,
          row.updatedAtMs,
        );
      return row;
    }
    const merged: BrownNosePrefs = {
      sessionKey,
      enabled: partial.enabled ?? existing.enabled,
      activeHours: partial.activeHours ?? existing.activeHours,
      timezone: partial.timezone ?? existing.timezone,
      weeklyCap: partial.weeklyCap ?? existing.weeklyCap,
      cooldownMultiplier: partial.cooldownMultiplier ?? existing.cooldownMultiplier,
      focusSuggestions: partial.focusSuggestions ?? existing.focusSuggestions,
      disabledReason:
        "disabledReason" in partial ? (partial.disabledReason ?? null) : existing.disabledReason,
      disabledAtMs:
        "disabledAtMs" in partial ? (partial.disabledAtMs ?? null) : existing.disabledAtMs,
      snoozeUntilMs: existing.snoozeUntilMs,
      snoozeSetAtMs: existing.snoozeSetAtMs,
      userNote: existing.userNote,
      updatedAtMs: Date.now(),
    };
    this.db
      .query(
        `UPDATE brown_nose_prefs
         SET enabled=?, active_hours_json=?, timezone=?, weekly_cap=?,
             cooldown_multiplier=?, focus_suggestions_json=?,
             disabled_reason=?, disabled_at_ms=?, updated_at_ms=?
         WHERE session_key=?`,
      )
      .run(
        merged.enabled ? 1 : 0,
        JSON.stringify(merged.activeHours),
        merged.timezone,
        merged.weeklyCap,
        merged.cooldownMultiplier,
        JSON.stringify(merged.focusSuggestions),
        merged.disabledReason,
        merged.disabledAtMs,
        merged.updatedAtMs,
        sessionKey,
      );
    return merged;
  }

  list(): BrownNosePrefs[] {
    const rows = this.db
      .query<PrefsRow, []>("SELECT * FROM brown_nose_prefs ORDER BY session_key")
      .all();
    return rows.map(rowToPrefs);
  }

  /** Drop a session's prefs entirely. Used by CLI --reset. */
  remove(sessionKey: SessionKey): void {
    this.db.query("DELETE FROM brown_nose_prefs WHERE session_key = ?").run(sessionKey);
  }

  /** Hard-delete a session's proactive fire history. Used by the user
   *  portal's privacy "erase everything" action. Returns rows removed. */
  deleteFires(sessionKey: SessionKey): number {
    const res = this.db.query("DELETE FROM brown_nose_fires WHERE session_key = ?").run(sessionKey);
    return Number(res.changes ?? 0);
  }

  /** Record a fire that actually invoked the main model. Starts
   *  undelivered; `markDelivered` flips it once the message is on the wire. */
  recordFire(input: {
    sessionKey: SessionKey;
    firedAtMs: number;
    brief: string;
    tags: string[];
  }): number {
    const res = this.db
      .query<{ id: number }, [string, number, string, string]>(
        `INSERT INTO brown_nose_fires (session_key, fired_at_ms, brief, tags_json, delivered)
         VALUES (?, ?, ?, ?, 0) RETURNING id`,
      )
      .get(input.sessionKey, input.firedAtMs, input.brief, JSON.stringify(input.tags));
    return res?.id ?? 0;
  }

  /** The proactive message actually reached the user — this fire is now
   *  eligible for behavior-based outcome scoring. */
  markDelivered(fireId: number): void {
    this.db.query("UPDATE brown_nose_fires SET delivered=1 WHERE id=?").run(fireId);
  }

  /** Backfill outcome on a previously-recorded fire. `reactionGlyph` is
   *  only meaningful with outcome "reacted". */
  recordOutcome(fireId: number, outcome: FireOutcome, reactionGlyph?: string): void {
    this.db
      .query("UPDATE brown_nose_fires SET outcome=?, outcome_at_ms=?, reaction_glyph=? WHERE id=?")
      .run(outcome, Date.now(), reactionGlyph ?? null, fireId);
  }

  /** Fires for a session in [sinceMs, nowMs]. Used for weekly-cap check. */
  firesSince(sessionKey: SessionKey, sinceMs: number): FireRecord[] {
    const rows = this.db
      .query<FireRow, [string, number]>(
        `SELECT * FROM brown_nose_fires
         WHERE session_key=? AND fired_at_ms >= ?
         ORDER BY fired_at_ms DESC`,
      )
      .all(sessionKey, sinceMs);
    return rows.map(rowToFire);
  }

  /** DELIVERED fires whose outcome hasn't been determined yet, oldest
   *  first. Consumed by the outcome backfill sweep (ghost/outcomes.ts).
   *  Undelivered rows (in-flight, vetoed-before-stamp, failed) are
   *  excluded — user behavior can't be a reaction to a message that
   *  never arrived. Legacy NULL rows predate the column and were
   *  delivered; keep them sweepable. */
  pendingOutcomes(limit: number): FireRecord[] {
    const rows = this.db
      .query<FireRow, [number]>(
        `SELECT * FROM brown_nose_fires
         WHERE outcome IS NULL AND (delivered IS NULL OR delivered = 1)
         ORDER BY fired_at_ms ASC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(rowToFire);
  }

  /**
   * Scored, DELIVERED fires across ALL sessions since `sinceMs` — the
   * input to the cross-session tag→outcome rollup (ghost/tag-stats.ts).
   * Vetoed/error rows carry no user signal and are excluded at the query.
   */
  allScoredFires(sinceMs: number, limit = 500): FireRecord[] {
    const rows = this.db
      .query<FireRow, [number, number]>(
        `SELECT * FROM brown_nose_fires
         WHERE fired_at_ms >= ?
           AND outcome IS NOT NULL AND outcome NOT IN ('vetoed','error')
           AND (delivered IS NULL OR delivered = 1)
         ORDER BY fired_at_ms DESC
         LIMIT ?`,
      )
      .all(sinceMs, limit);
    return rows.map(rowToFire);
  }

  /** Most recent N fires regardless of time. Used for engagement decay
   *  and the `--show` CLI snapshot. */
  recentFires(sessionKey: SessionKey, limit: number): FireRecord[] {
    const rows = this.db
      .query<FireRow, [string, number]>(
        `SELECT * FROM brown_nose_fires
         WHERE session_key=?
         ORDER BY fired_at_ms DESC
         LIMIT ?`,
      )
      .all(sessionKey, limit);
    return rows.map(rowToFire);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * One-time auto-enrollment migration. For every session in the
 * provided list that doesn't yet have a brown_nose_prefs row, insert
 * one with the supplied defaults. Idempotent; safe to call on every
 * daemon boot.
 *
 * Returns the number of newly-enrolled sessions (purely for log noise).
 */
export function autoEnrollSessions(
  store: GhostPrefsStore,
  sessions: Array<{ sessionKey: SessionKey; isGroup: boolean }>,
  defaults: {
    dmEnabled: boolean;
    groupEnabled: boolean;
    timezone: string;
    weeklyCap: number;
  },
): number {
  let added = 0;
  for (const s of sessions) {
    // Trading sessions are bot channels with their own scheduled cadence —
    // never enroll them for proactive outreach. Orchestrator sessions
    // belong to other personas — the main-persona ghost stays out.
    if (s.sessionKey.startsWith("trading:") || s.sessionKey.startsWith("orch:")) continue;
    if (store.get(s.sessionKey)) continue;
    const isGroup = s.isGroup;
    store.upsert(s.sessionKey, {
      defaultsIfNew: {
        enabled: isGroup ? defaults.groupEnabled : defaults.dmEnabled,
        activeHours: isGroup ? DEFAULT_ACTIVE_HOURS_GROUP : DEFAULT_ACTIVE_HOURS_DM,
        timezone: defaults.timezone,
        weeklyCap: defaults.weeklyCap,
      },
    });
    added++;
  }
  return added;
}

function rowToPrefs(row: PrefsRow): BrownNosePrefs {
  return {
    sessionKey: row.session_key as SessionKey,
    enabled: row.enabled === 1,
    activeHours: JSON.parse(row.active_hours_json) as ActiveHoursWindow[],
    timezone: row.timezone,
    weeklyCap: row.weekly_cap,
    cooldownMultiplier: row.cooldown_multiplier,
    focusSuggestions: JSON.parse(row.focus_suggestions_json) as FocusSuggestion[],
    disabledReason: row.disabled_reason,
    disabledAtMs: row.disabled_at_ms,
    snoozeUntilMs: row.snooze_until_ms ?? null,
    snoozeSetAtMs: row.snooze_set_at_ms ?? null,
    userNote: row.user_note ?? null,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * Is this session's ghost snooze currently in effect? A snooze holds only
 * while (a) it hasn't expired and (b) the user hasn't sent anything since
 * it was set — new inbound always voids it.
 */
export function snoozeActive(
  prefs: Partial<Pick<BrownNosePrefs, "snoozeUntilMs" | "snoozeSetAtMs">>,
  lastInboundMs: number,
  nowMs: number,
): boolean {
  // == null catches undefined too — objects predating the snooze columns
  // (old rows, test fixtures) must read as "no snooze", not "snoozed".
  if (prefs.snoozeUntilMs == null || prefs.snoozeUntilMs <= nowMs) return false;
  if (lastInboundMs > (prefs.snoozeSetAtMs ?? 0)) return false;
  return true;
}

function rowToFire(row: FireRow): FireRecord {
  return {
    id: row.id,
    sessionKey: row.session_key as SessionKey,
    firedAtMs: row.fired_at_ms,
    brief: row.brief,
    tags: JSON.parse(row.tags_json) as string[],
    outcome: row.outcome as FireRecord["outcome"],
    outcomeAtMs: row.outcome_at_ms,
    reactionGlyph: row.reaction_glyph ?? null,
    // Legacy rows predate the column: they were recorded at fire time and
    // (almost always) delivered — treat NULL as delivered so history keeps
    // participating in decay/caps exactly as before.
    delivered: row.delivered !== 0,
  };
}
