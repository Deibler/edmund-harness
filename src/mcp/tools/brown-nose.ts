import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveIntensity } from "../../ghost/intensity.ts";
import {
  type ActiveHoursWindow,
  DEFAULT_ACTIVE_HOURS_DM,
  DEFAULT_ACTIVE_HOURS_GROUP,
  type FocusSuggestion,
  GhostPrefsStore,
} from "../../ghost/prefs.ts";
import { sandboxDir } from "../../persona/sandbox.ts";
import { loadPortalSecret, portalUrl } from "../../portal/token.ts";
import type { SessionKey } from "../../sessions/key.ts";
import { easternDate } from "../../util/clock.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Brown-nose self-control surface — tools the **main** model can call
 * (and which the user can invoke verbally; the model translates "stop
 * brown-nosing me" / "focus on X instead" into the right call).
 *
 * All operations target the CURRENT session (from EDMUND_SESSION_KEY)
 * so the model can't reach into other chats. Operator-wide controls
 * live in `edmund sessions brownnose …` and edits to `config.toml`.
 *
 * The 7 tools:
 *   • set_brown_nose         — bulk-update prefs for this session
 *   • disable_brown_nose     — turn off + record reason (no auto-re-enable)
 *   • enable_brown_nose      — undo a previous disable
 *   • add_focus_suggestion   — user wants ghost biased toward a topic
 *   • clear_focus_suggestions — reset all topic biases
 *   • query_ghost            — inspect recent ghost decisions in this chat
 *   • ghost_status           — snapshot: enabled? cap? cooldown? next eligible window?
 *
 * Engagement decay still applies on top of all of this — disabled
 * sessions can be re-enabled, but the cooldown multiplier persists
 * across the disable/enable cycle until a positive-engagement fire
 * resets it.
 */

const DOW_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const ActiveHourSchema = z.object({
  dow: z.enum(DOW_VALUES),
  start: z.string().regex(/^\d{1,2}:\d{2}$/),
  end: z.string().regex(/^\d{1,2}:\d{2}$/),
});

const SetBrownNoseInput = z
  .object({
    enabled: z.boolean().optional().describe("Master switch for brown-nose in THIS chat."),
    active_hours: z
      .array(ActiveHourSchema)
      .optional()
      .describe(
        "Day-of-week windows when the ghost may fire. Day names: mon, tue, wed, thu, fri, sat, sun. Time format HH:MM 24h. Default M-F 09:00-19:00. Empty array = never fire.",
      ),
    weekly_cap: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Max proactive outreaches per week in this chat. Default depends on intensity."),
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone name (e.g. 'America/New_York', 'Europe/London') for active hours."),
    user_note: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "The user's standing preference about proactive contact, in their words ('only fishing and weather stuff', 'never before noon'). The ghost reads it every tick. Empty string clears it. Set this when the user TELLS you a preference — same field they can edit on their portal page.",
      ),
  })
  .strict();

const DisableInput = z
  .object({
    reason: z
      .string()
      .min(1)
      .describe(
        "Why brown-nose is being turned off. Include the user's actual signal — 'user said stop on 2026-05-13', 'pushed back on weather brief', etc. Persisted so future re-enables have context.",
      ),
  })
  .strict();

const AddFocusInput = z
  .object({
    topic: z
      .string()
      .min(1)
      .max(140)
      .describe(
        "What the user wants ghost biased toward. Keep specific: 'software development & projects', 'cooper photos', 'weekend planning'. Vague topics ('helpful stuff') don't shape behavior.",
      ),
    duration_days: z
      .number()
      .int()
      .positive()
      .max(365)
      .optional()
      .describe("Auto-expire this suggestion after N days. Omit for no expiry."),
  })
  .strict();

const QueryGhostInput = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "What you want to understand about ghost behavior in THIS chat. The tool returns recent decisions + budget state — you interpret them and answer the user.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(15)
      .describe("How many recent decisions to surface."),
  })
  .strict();

export function brownNoseTools(ctx: ToolContext): ToolDef[] {
  const sessionKey = ctx.sessionKey as SessionKey;

  return [
    {
      name: "set_brown_nose",
      description:
        "Update brown-nose preferences for THIS chat — when the assistant may proactively reach out, how often, in what timezone. Use when the user says things like 'you can do this on weekends too', 'only fridays', 'no more than twice a week', 'switch to Pacific time'. Translates natural-language tuning into structured prefs. Persists across sessions.",
      inputSchema: SetBrownNoseInput,
      handler: (args) => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          const update: Parameters<GhostPrefsStore["upsert"]>[1] = {};
          if (args.enabled !== undefined) update.enabled = args.enabled;
          if (args.active_hours !== undefined) {
            update.activeHours = args.active_hours as ActiveHoursWindow[];
          }
          if (args.weekly_cap !== undefined) update.weeklyCap = args.weekly_cap;
          if (args.timezone !== undefined) update.timezone = args.timezone;
          update.defaultsIfNew = defaultsFromConfig(ctx, sessionKey);
          const merged = prefs.upsert(sessionKey, update);
          if (args.user_note !== undefined) {
            prefs.setUserNote(sessionKey, args.user_note);
          }
          return text(
            `brown-nose updated for this chat\n  enabled: ${merged.enabled}\n  active hours: ${formatActiveHours(merged.activeHours)}\n  weekly cap: ${merged.weeklyCap}\n  timezone: ${merged.timezone}${
              args.user_note !== undefined
                ? `\n  user note: ${args.user_note.trim() || "(cleared)"}`
                : ""
            }`,
          );
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "disable_brown_nose",
      description:
        "Turn off proactive outreach for THIS chat and record why. Call this immediately when the user signals annoyance (push-back, 'stop', 'not now, please', irritation in the reply to a previous proactive move). **Never auto-re-enables** — the user must explicitly say 'you can do that again' for `enable_brown_nose` to be called. After calling this, write a feedback memory about what triggered the push-back so the next operator review has context.",
      inputSchema: DisableInput,
      handler: (args) => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          prefs.upsert(sessionKey, {
            enabled: false,
            disabledReason: args.reason,
            disabledAtMs: Date.now(),
            defaultsIfNew: defaultsFromConfig(ctx, sessionKey),
          });
          // A disable after push-back is the strongest engagement signal we
          // have — stamp the most recent DELIVERED fire so decay learns from
          // it (the deterministic backfill sweep only ever infers
          // engaged/ignored; pushed_back is a judgment call that lands
          // exactly here). Skip vetoed/errored rows: the user can only be
          // pushing back on a message that actually reached them.
          const recent = prefs
            .recentFires(sessionKey, 5)
            .find((f) => f.delivered && (f.outcome === null || f.outcome === "engaged"));
          if (recent) {
            prefs.recordOutcome(recent.id, "pushed_back");
          }
          return text(`brown-nose disabled for this chat\nreason recorded: ${args.reason}`);
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "enable_brown_nose",
      description:
        "Re-enable proactive outreach for THIS chat after a previous disable. Only call when the user has EXPLICITLY said something like 'you can start brown-nosing me again', 'you can reach out again', 'turn that back on'. Don't infer — wait for the words. Inherits prior active hours / weekly cap unless changed via `set_brown_nose`.",
      inputSchema: z.object({}).strict(),
      handler: () => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          prefs.upsert(sessionKey, {
            enabled: true,
            disabledReason: null,
            disabledAtMs: null,
            defaultsIfNew: defaultsFromConfig(ctx, sessionKey),
          });
          return text("brown-nose re-enabled for this chat");
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "add_focus_suggestion",
      description:
        "Bias ghost toward a specific topic in THIS chat. Use when the user says 'focus on X instead', 'reach out more about Y', 'I'd love it if you did Z'. The suggestion is consumable: ghost can act on each topic at most 3 times per week — over-use auto-throttles the topic, AND if the user gets annoyed because ghost leans on the suggestion too heavily, that's grounds for `disable_brown_nose`. So apply suggestions carefully; they're a starting bias, not a mandate.",
      inputSchema: AddFocusInput,
      handler: (args) => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          const row = prefs.get(sessionKey);
          const existing = row?.focusSuggestions ?? [];
          // De-dupe: if a suggestion with the same topic already exists,
          // refresh its expiry rather than adding a second.
          const lower = args.topic.toLowerCase();
          const filtered = existing.filter((s) => s.topic.toLowerCase() !== lower);
          const expiresAtMs = args.duration_days
            ? Date.now() + args.duration_days * 24 * 3_600_000
            : null;
          const next: FocusSuggestion = {
            topic: args.topic,
            usageCount: 0,
            expiresAtMs,
            createdAtMs: Date.now(),
          };
          prefs.upsert(sessionKey, {
            focusSuggestions: [...filtered, next],
            defaultsIfNew: defaultsFromConfig(ctx, sessionKey),
          });
          const expiry = expiresAtMs ? ` (expires ${easternDate(new Date(expiresAtMs))})` : "";
          return text(
            `focus suggestion recorded: "${args.topic}"${expiry}\nghost will bias toward this topic, capped at 3 uses/week.`,
          );
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "clear_focus_suggestions",
      description:
        "Drop every focus-suggestion topic for THIS chat. Use when the user says 'never mind those suggestions', 'just do what you think is best', or after a push-back where the user implied your topic bias caused the problem.",
      inputSchema: z.object({}).strict(),
      handler: () => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          const row = prefs.get(sessionKey);
          const removed = row?.focusSuggestions.length ?? 0;
          prefs.upsert(sessionKey, {
            focusSuggestions: [],
            defaultsIfNew: defaultsFromConfig(ctx, sessionKey),
          });
          return text(`cleared ${removed} focus suggestion${removed === 1 ? "" : "s"}.`);
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "query_ghost",
      description:
        "Inspect recent ghost decisions for THIS chat. Returns the last N entries from the decisions log (act/no, reason, brief if any, timestamps) plus current budget state (cooldown, weekly cap usage, focus suggestions). Use when the user asks 'why did you randomly text me about X?' or 'what are you tracking for me?' — read the result, then answer the user in your own voice. Don't dump the JSON at them.",
      inputSchema: QueryGhostInput,
      handler: (args) => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          const row = prefs.get(sessionKey);
          const decisions = readRecentDecisions(sessionKey, args.limit);
          const recentFires = prefs.recentFires(sessionKey, 5);

          const lines: string[] = [];
          lines.push(`question: ${args.question}`);
          lines.push("");
          if (!row) {
            lines.push("brown-nose: not enrolled for this session");
          } else {
            lines.push(`brown-nose: ${row.enabled ? "on" : "off"}`);
            if (!row.enabled && row.disabledReason) {
              lines.push(`  disabled reason: ${row.disabledReason}`);
            }
            lines.push(`  weekly cap: ${row.weeklyCap}`);
            lines.push(`  cooldown ×: ${row.cooldownMultiplier.toFixed(1)}`);
            lines.push(`  active hours: ${formatActiveHours(row.activeHours)}`);
            if (row.snoozeUntilMs && row.snoozeUntilMs > Date.now()) {
              lines.push(
                `  ghost snooze: until ${new Date(row.snoozeUntilMs).toISOString()} (voided by any new inbound)`,
              );
            }
            if (row.focusSuggestions.length > 0) {
              lines.push("  focus suggestions:");
              for (const s of row.focusSuggestions) {
                lines.push(`    - ${s.topic} (used ${s.usageCount}/3 this week)`);
              }
            }
          }
          lines.push("");
          lines.push(`recent fires (${recentFires.length}):`);
          for (const f of recentFires) {
            lines.push(
              `  ${new Date(f.firedAtMs).toISOString()} [${f.outcome ?? "pending"}] tags=${JSON.stringify(f.tags)} brief="${f.brief.slice(0, 120)}"`,
            );
          }
          lines.push("");
          lines.push(`recent ghost decisions (${decisions.length}):`);
          for (const d of decisions) {
            const when = new Date(d.tickAtMs).toISOString();
            if (d.act) {
              lines.push(
                `  ${when} ACT tags=${JSON.stringify(d.tags)} confidence=${d.confidence} fire_at=${new Date(d.fireAtMs).toISOString()}`,
              );
              lines.push(`    brief: ${d.brief.slice(0, 200)}`);
            } else {
              lines.push(`  ${when} NO reason="${d.reason.slice(0, 200)}"`);
            }
          }
          return text(lines.join("\n"));
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "ghost_status",
      description:
        "Quick snapshot of brown-nose state for THIS chat. Less detail than `query_ghost` — use when the user asks 'is that on?' / 'what's your setup right now?' and just wants a one-line answer. Returns enabled? · weekly cap · cooldown × · next eligible time · count of focus suggestions.",
      inputSchema: z.object({}).strict(),
      handler: () => {
        const prefs = new GhostPrefsStore(ctx.dataDir);
        try {
          const row = prefs.get(sessionKey);
          if (!row) return text("brown-nose: not enrolled for this session");
          const params = resolveIntensity(ctx.config.brown_nose.intensity);
          const recent = prefs.recentFires(sessionKey, 1);
          const lastFire = recent[0];
          const nextEligibleMs = lastFire
            ? lastFire.firedAtMs + params.cooldownHours * 3_600_000 * row.cooldownMultiplier
            : 0;
          const lines = [
            `enabled: ${row.enabled}`,
            `weekly cap: ${row.weeklyCap}`,
            `cooldown ×: ${row.cooldownMultiplier.toFixed(1)} (intensity ${ctx.config.brown_nose.intensity} → ${params.cooldownHours}h base)`,
            `active hours: ${formatActiveHours(row.activeHours)} ${row.timezone}`,
            `focus suggestions: ${row.focusSuggestions.length}`,
            `next eligible: ${
              nextEligibleMs > Date.now()
                ? new Date(nextEligibleMs).toISOString()
                : "(now — no active cooldown)"
            }`,
          ];
          if (!row.enabled && row.disabledReason) {
            lines.push(`disabled reason: ${row.disabledReason}`);
          }
          return text(lines.join("\n"));
        } finally {
          prefs.close();
        }
      },
    },
    {
      name: "get_portal_link",
      description:
        "Get THIS chat's standing personal portal link — a full self-service page scoped to this one conversation: proactive-message settings (on/off, allowed hours, a note to the ghost), a gallery of every image/video/voice memo from the chat, the files and artifacts you've made, their schedules (view, pause, create their own), usage analytics, what you remember about them (DMs), tips for getting the best out of you, and a privacy page where they can wipe their data. Send it whenever the user asks how to control proactive contact, wants to browse what you've made for them, asks about their data/privacy, or asks 'how do I get more out of you?'. Permanent, scoped to this chat only. (Every proactive message also carries it automatically — this tool is for sending it on request.)",
      inputSchema: z.object({}).strict(),
      handler: () => {
        try {
          const url = portalUrl(ctx.config, loadPortalSecret(ctx.dataDir), sessionKey);
          return text(
            `${url}\n\nSend this to the user with a one-line explanation, matched to why they asked (it's their personal page for this chat — proactive settings, all the media/files you've made, schedules, stats, and privacy controls — theirs alone, always works).`,
          );
        } catch (e) {
          return text(`could not build portal link: ${(e as Error).message}`);
        }
      },
    },
  ];
}

// ---- internal helpers ----

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function formatActiveHours(hours: ActiveHoursWindow[]): string {
  if (hours.length === 0) return "(none — never fires)";
  return hours.map((w) => `${w.dow} ${w.start}-${w.end}`).join(", ");
}

function defaultsFromConfig(
  ctx: ToolContext,
  sessionKey: SessionKey,
): {
  enabled: boolean;
  activeHours: ActiveHoursWindow[];
  timezone: string;
  weeklyCap: number;
} {
  const isGroup = sessionKey.startsWith("imessage:group:");
  const params = resolveIntensity(ctx.config.brown_nose.intensity);
  return {
    enabled: isGroup
      ? ctx.config.brown_nose.groups_enabled_by_default
      : ctx.config.brown_nose.dms_enabled_by_default,
    // Single source of truth in prefs.ts. The inline arrays this used to
    // carry were the LEGACY defaults — M-F 9-19 for DMs and, worse, []
    // for groups: prefs.ts documents [] as the bug that made every group
    // permanently unable to fire, fixed there with a backfill... while a
    // group whose first row came through set_brown_nose was re-born with
    // the same [] and a cheerful success message.
    activeHours: isGroup ? DEFAULT_ACTIVE_HOURS_GROUP : DEFAULT_ACTIVE_HOURS_DM,
    timezone: ctx.config.brown_nose.default_timezone,
    weeklyCap: params.weeklyCap,
  };
}

type StoredDecision =
  | { act: false; reason: string; tickAtMs: number }
  | {
      act: true;
      tickAtMs: number;
      fireAtMs: number;
      brief: string;
      tags: string[];
      expiresAtMs: number;
      confidence: "low" | "medium" | "high";
    };

/** Read the tail of <sandbox>/brownnose/decisions.jsonl. Newest first. */
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
