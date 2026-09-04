import { z } from "zod";
import * as intSettings from "../../integrations/settings.ts";
import { hostAccess } from "../../security/policy.ts";
import {
  evaluateTrigger,
  probeAppJs,
  probeChatSilence,
  probeUrl,
} from "../../triggers/evaluate.ts";
import { DataTriggerStore, type TriggerSource } from "../../triggers/store.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Model-authored data triggers. The model designs the whole condition —
 * probe + predicate — from its own understanding of the data contracts
 * (RadarOmega internals it has introspected, api.weather.gov, NHC, SPC,
 * any JSON endpoint). The daemon evaluates for free on a schedule and
 * invokes the model only when a condition fires.
 */

const MAX_ARMED_PER_SESSION = 12;
/** Across ALL sessions — bounds total daemon probe traffic. */
const MAX_ARMED_GLOBAL = 80;

const SetInput = z
  .object({
    name: z.string().min(1).describe("Short human name, e.g. 'Tornado warning — Lancaster Co'."),
    brief: z
      .string()
      .min(1)
      .describe(
        "Note to future-you: why this trigger exists and EXACTLY what you promised to do when it fires (who to tell, what to show). You'll be woken with this text.",
      ),
    source_url: z
      .string()
      .optional()
      .describe(
        "URL probe: fetched every check, JSON (or raw text) handed to your predicate as `data`. Examples: api.weather.gov/alerts/active?area=PA, nhc.noaa.gov/CurrentStorms.json, SPC geojson outlooks, any endpoint whose contract you know.",
      ),
    source_headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional headers for the URL probe."),
    source_method: z
      .enum(["GET", "POST"])
      .optional()
      .describe("URL probe HTTP method. POST + source_body = webhook-style call."),
    source_body: z
      .string()
      .optional()
      .describe(
        "Body for a POST URL probe (sent verbatim; Content-Type defaults to application/json).",
      ),
    silence_watch: z
      .object({
        handle: z.string().optional().describe("DM handle, e.g. '+15550100002'."),
        chat_guid: z.string().optional().describe("Exact chat guid (any DM or group)."),
      })
      .optional()
      .describe(
        "INTERNAL-STATE probe (instead of source_url/app_js): watches a chat's own silence via chat.db. Your predicate receives {lastInboundMs, lastOutboundMs, hoursSinceInbound, hoursSinceOutbound, nowMs} — tapbacks don't count as hearing from them. Express things like \"if I haven't heard from Pat in 5 days\" as `data.hoursSinceInbound !== null && data.hoursSinceInbound > 120`. Give handle for a DM or chat_guid for exact targeting.",
      ),
    app_js: z
      .string()
      .optional()
      .describe(
        "App probe (instead of source_url): a JS expression evaluated INSIDE the live RadarOmega renderer each check — full access to window['0'] and window.__claude_map (the contracts you've introspected). Return a JSON-serializable value; it becomes `data`. Use for conditions only the app can see (model fields, lightning rates, app warning layers). Requires the app to be running 24/7 (it is) — prefer source_url when an equivalent public endpoint exists; it's sturdier.",
      ),
    predicate: z
      .string()
      .min(1)
      .describe(
        "JS function BODY receiving (data, state): return true/false or {fire: bool, summary: string}. `state` is YOUR persistent scratch object across checks — use it to dedupe (seen IDs), detect changes (last value), or count. ALWAYS dedupe via state for recurring triggers or you'll refire on the same event every check. Make summary rich — it's the context you wake up with.",
      ),
    check_interval_minutes: z
      .number()
      .min(1)
      .max(1440)
      .default(5)
      .describe(
        "How often to evaluate. Match the data's tempo: warnings 2-5m, model runs 60m+, outlooks 6h.",
      ),
    cooldown_minutes: z
      .number()
      .min(0)
      .max(1440)
      .default(30)
      .describe(
        "Min gap between fires for recurring triggers (suppressed events do NOT fire later).",
      ),
    one_shot: z
      .boolean()
      .default(false)
      .describe("true = fire once then done (e.g. 'when the storm forms'). false = keep watching."),
    expires: z
      .string()
      .optional()
      .describe(
        "ISO datetime when this trigger stops being relevant and expires itself. Set it whenever the watch has a natural end.",
      ),
  })
  .strict();

export function triggerTools(ctx: ToolContext): ToolDef[] {
  const store = () => new DataTriggerStore(ctx.dataDir);
  const probe = (source: TriggerSource) => {
    if (source.kind === "url") {
      return probeUrl(source.url, source.headers, { method: source.method, body: source.body });
    }
    if (source.kind === "chat_silence") {
      return Promise.resolve(probeChatSilence(ctx.chatDb, source));
    }
    return probeAppJs(source.expression, intSettings.radaromega(ctx.config).cdp_port);
  };

  return [
    {
      name: "set_trigger",
      description:
        "Arm a DATA TRIGGER — a condition YOU design that the daemon checks on schedule for free, waking you ONLY when it fires (vs a mission, which wakes you every check). You write both the probe (any URL, or a JS expression inside the live RadarOmega app) and the predicate. Anything you can express is watchable: 'tornado warning touches Lancaster County', 'a tropical storm forms in the Atlantic', 'HRRR updraft helicity over the area exceeds X in the new run', 'a mesoscale discussion mentions southeast PA'. The trigger is validated by running one real check on creation (which also primes your state — existing conditions won't refire unless your predicate says so). After arming, tell the user in one line what's now watching and what happens when it fires.",
      inputSchema: SetInput,
      handler: async (args) => {
        const sourceCount =
          (args.source_url ? 1 : 0) + (args.app_js ? 1 : 0) + (args.silence_watch ? 1 : 0);
        if (sourceCount !== 1) {
          return err("provide exactly one of source_url, app_js, or silence_watch");
        }
        if (hostAccess(ctx.config) !== "full") {
          return err(
            'data triggers run a predicate you write as code on the daemon, and this deployment keeps the model off the host ([security].model_host_access = "sandboxed"). Use schedule_reminder for a timed check instead',
          );
        }
        if (args.silence_watch && !args.silence_watch.handle && !args.silence_watch.chat_guid) {
          return err("silence_watch needs handle or chat_guid");
        }
        if (args.app_js && !intSettings.radaromega(ctx.config).enabled) {
          return err(
            "app_js probes need the RadarOmega integration, which is disabled in config ([radaromega] enabled = false) — express the condition as a source_url probe instead",
          );
        }
        const s = store();
        try {
          if (s.countArmedBySession(ctx.sessionKey) >= MAX_ARMED_PER_SESSION) {
            return err(
              `this chat already has ${MAX_ARMED_PER_SESSION} armed triggers — cancel one first (list_triggers)`,
            );
          }
          if (s.countArmed() >= MAX_ARMED_GLOBAL) {
            return err(
              `the daemon already has ${MAX_ARMED_GLOBAL} armed triggers across all chats — stale ones need canceling before new ones arm`,
            );
          }
          let expiresMs: number | null = null;
          if (args.expires) {
            const t = Date.parse(args.expires);
            if (Number.isNaN(t)) return err(`unparseable expires: ${args.expires}`);
            if (t < Date.now()) return err(`expires is already in the past: ${args.expires}`);
            expiresMs = t;
          }
          const source: TriggerSource = args.source_url
            ? {
                kind: "url",
                url: args.source_url,
                headers: args.source_headers,
                method: args.source_method,
                body: args.source_body,
              }
            : args.silence_watch
              ? {
                  kind: "chat_silence",
                  handle: args.silence_watch.handle,
                  chatGuid: args.silence_watch.chat_guid,
                }
              : { kind: "app_js", expression: args.app_js as string };

          // Validation check: run the probe + predicate once, for real. A
          // broken URL or throwing predicate fails HERE, not silently at
          // 3am. The state it produces primes dedupe.
          let first: Awaited<ReturnType<typeof evaluateTrigger>>;
          try {
            first = await evaluateTrigger(source, args.predicate, {}, probe);
          } catch (e) {
            return err(
              `trigger NOT armed — first check failed: ${(e as Error).message}. Fix the probe/predicate and retry.`,
            );
          }

          const trigger = s.create({
            sessionKey: ctx.sessionKey,
            name: args.name,
            brief: args.brief,
            source,
            predicate: args.predicate,
            state: first.state,
            oneShot: args.one_shot,
            checkIntervalMs: Math.round(args.check_interval_minutes * 60_000),
            cooldownMs: Math.round(args.cooldown_minutes * 60_000),
            expiresMs,
          });
          return ok(
            [
              `armed trigger ${trigger.id} (${trigger.name}) — checking every ${args.check_interval_minutes}m${expiresMs ? `, expires ${new Date(expiresMs).toISOString()}` : ""}.`,
              `First check ran clean: ${first.fire ? `WOULD HAVE FIRED — "${first.summary.slice(0, 200)}". Its state is now primed, so this existing condition won't refire; if the user should hear about the CURRENT situation, tell them yourself now.` : first.summary.slice(0, 200)}`,
              `Tell the user in one line what's now watching.`,
            ].join("\n"),
          );
        } finally {
          s.close();
        }
      },
    },
    {
      name: "list_triggers",
      description:
        "List this chat's data triggers: status, schedule, fire count, and any lastError (a persistently erroring trigger needs its probe/predicate fixed — cancel and re-set it).",
      inputSchema: z.object({}),
      handler: () => {
        const s = store();
        try {
          const all = s.listBySession(ctx.sessionKey);
          if (all.length === 0) return ok("no triggers");
          const lines = all.map((t) => {
            const src =
              t.source.kind === "url"
                ? t.source.url
                : t.source.kind === "chat_silence"
                  ? `silence watch (${t.source.handle ?? t.source.chatGuid})`
                  : "app_js probe";
            const failing =
              t.consecutiveFailures > 0
                ? ` — FAILING ${t.consecutiveFailures}× in a row (checks backing off; fix or cancel)`
                : "";
            const err_ = t.lastError ? ` — LAST ERROR: ${t.lastError}` : "";
            const fired = t.fireCount > 0 ? ` — fired ${t.fireCount}×` : "";
            return `• ${t.id} [${t.status}] ${t.name} — ${src} every ${Math.round(t.checkIntervalMs / 60_000)}m${fired}${failing}${err_}\n  brief: ${t.brief.slice(0, 140)}`;
          });
          return ok(lines.join("\n"));
        } finally {
          s.close();
        }
      },
    },
    {
      name: "cancel_trigger",
      description:
        "Disarm a trigger from this chat (it served its purpose, plans changed, or it needs a rewrite).",
      inputSchema: z.object({ trigger_id: z.string() }),
      handler: (args) => {
        const s = store();
        try {
          const t = s.get(args.trigger_id);
          if (!t || t.sessionKey !== ctx.sessionKey)
            return err(`no trigger ${args.trigger_id} in this chat`);
          return s.cancel(args.trigger_id, ctx.sessionKey)
            ? ok(`canceled ${args.trigger_id} (${t.name})`)
            : err(`trigger ${args.trigger_id} is already ${t.status}`);
        } finally {
          s.close();
        }
      },
    },
    {
      name: "test_trigger",
      description:
        "Dry-run a trigger right now: runs the real probe + predicate and reports whether it would fire, WITHOUT firing or changing its schedule/state. Use to debug a trigger that has lastError set or that you suspect is mis-specified.",
      inputSchema: z.object({ trigger_id: z.string() }),
      handler: async (args) => {
        const s = store();
        try {
          const t = s.get(args.trigger_id);
          if (!t || t.sessionKey !== ctx.sessionKey)
            return err(`no trigger ${args.trigger_id} in this chat`);
          try {
            const r = await evaluateTrigger(t.source, t.predicate, structuredClone(t.state), probe);
            return ok(`wouldFire=${r.fire} — ${r.summary.slice(0, 600)}`);
          } catch (e) {
            return err(`check failed: ${(e as Error).message}`);
          }
        } finally {
          s.close();
        }
      },
    },
  ];
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
