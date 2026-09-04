import { resolve } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";
import { runRefreshScriptSource } from "../../src/refresh/runner.ts";
import { RefreshScriptStore } from "../../src/refresh/store.ts";
import { hostAccess } from "../../src/security/policy.ts";
import { genId } from "../../src/util/ids.ts";
import { assertPathSafe } from "../../src/util/path-safety.ts";
import { mirrorConfig } from "./config.ts";
import { applyMirrorRefresh } from "./refresh.ts";
import { publishMirrorAsset } from "./src/assets.ts";
import { isMirrorSession } from "./src/context.ts";
import {
  MIRROR_INTENTS,
  MirrorComponentSpecSchema,
  MirrorLifespanSchema,
  MirrorPresentationSchema,
  type MirrorZone,
  MirrorZoneSchema,
  mirrorFrameId,
  placementForIntent,
  placementZone,
  summarizeContent,
} from "./src/protocol.ts";
import { type MirrorContentInput, MirrorStore } from "./src/store.ts";

export const MirrorLifespanInputSchema = z.preprocess(
  (value) => (typeof value === "string" ? { mode: value } : value),
  z
    .object({
      mode: MirrorLifespanSchema.default("ephemeral"),
      ttl_seconds: z.number().int().min(15).max(86_400).nullable().optional(),
    })
    .default({ mode: "ephemeral" }),
);
export const MIRROR_CLOSE_TOOL_NAME = "Close";
const LifespanInput = MirrorLifespanInputSchema;

const ContentBaseInput = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/)
    .optional()
    .describe("Stable ID. Reuse it to replace/update the same content."),
  page: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/)
    .default("home"),
  // Defaulted rather than required-with-a-refine on purpose. A `.refine()`
  // produces a ZodEffects, and an unsupported zod node in this converter
  // does not fail loudly — it publishes an EMPTY tool schema and the model
  // is left guessing the call shape. Not worth it for an invariant a good
  // default expresses anyway: content with no stated intent and no zone is
  // an answer, which is what almost all of it is.
  intent: z
    .enum(MIRROR_INTENTS)
    .default("answer")
    .describe(
      "What this content is FOR; the mirror works out where it goes. " +
        "'ambient' = glanceable, unrelated to the conversation, lives at an edge and outlives it (weather, a countdown). " +
        "'answer' = the reply to what was just asked; a full-width band that leaves on its own. " +
        "'focus' = the one thing to look at and use right now; it takes the whole glass (a recipe mid-cook, a running timer, a draft awaiting confirmation). " +
        "Prefer this over picking a zone: zone, presentation, lifespan and priority all depend on the panel, on what else is up, and on where the conversation dock is about to open.",
    ),
  zone: MirrorZoneSchema.optional().describe(
    "Override the zone the intent would have chosen. Only worth setting when you have a specific reason the device could not know.",
  ),
  presentation: MirrorPresentationSchema.optional(),
  lifespan: LifespanInput.optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

const RenderInput = z.intersection(ContentBaseInput, MirrorComponentSpecSchema);
/** Exported for refresh.ts: deterministic refresh scripts must produce a
 *  value that validates EXACTLY like an update_mirror_content call. */
export const UpdateInput = z.intersection(
  ContentBaseInput.extend({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/),
  }),
  MirrorComponentSpecSchema,
);

const StateKeyInput = z.object({
  widget_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,79}$/),
  key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,79}$/),
});

export function mirrorTools(ctx: ToolContext): ToolDef[] {
  if (!mirrorConfig(ctx.config).enabled) return [];

  const withStore = <T>(fn: (store: MirrorStore) => T): T => {
    const store = new MirrorStore(ctx.dataDir);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  return [
    {
      name: MIRROR_CLOSE_TOOL_NAME,
      description:
        "Close the active Mirror chat UI and end its attached voice conversation. This does not cancel already-started background work. Use it when the conversation is complete or the user asks to dismiss the chat, then finish with [SILENT].",
      inputSchema: z.object({}),
      handler: async () => {
        if (!isMirrorSession(ctx.sessionKey)) {
          return {
            content: [{ type: "text", text: "Close() is only available in a Mirror session." }],
            isError: true,
          };
        }
        const id = withStore((store) => store.enqueueLocalClose());
        return {
          content: [
            {
              type: "text",
              text: `Mirror chat closed (${id}). Finish this turn with [SILENT].`,
            },
          ],
        };
      },
    },
    {
      name: "render_mirror_content",
      description:
        "Render safe, typed content on the smart mirror. The component and its props are schema-validated; HTML/CSS/scripts are impossible — if there is no component for what you want to show, say so rather than building one out of an image. Say what the content is FOR with `intent` (ambient / answer / focus) and let the mirror place it; zone, presentation, lifespan and priority are overrides for when you have a reason the device could not know. Returns the stable content ID.",
      inputSchema: RenderInput,
      handler: async (args) => {
        const id = args.id ?? safeContentId(args.component);
        const content = withStore((store) =>
          store.upsertContent(
            toContentInput({ ...args, id }, mirrorConfig(ctx.config).default_ttl_seconds),
            "tool.render",
          ),
        );
        return {
          content: [
            {
              type: "text",
              text: `queued ${summarizeContent(content)}`,
            },
          ],
        };
      },
    },
    {
      name: "update_mirror_content",
      description:
        "Replace an existing mirror content item by stable ID with a fully validated typed component. Read list_mirror_content first if you do not know its current placement.",
      inputSchema: UpdateInput,
      handler: async (args) => {
        const content = withStore((store) =>
          store.upsertContent(
            toContentInput(args, mirrorConfig(ctx.config).default_ttl_seconds),
            "tool.update",
          ),
        );
        return { content: [{ type: "text", text: `queued ${summarizeContent(content)}` }] };
      },
    },
    {
      name: "remove_mirror_content",
      description:
        "Remove one mirror content item by stable ID. Protected baseline fixtures cannot be removed.",
      inputSchema: z.object({
        id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/),
      }),
      handler: async ({ id }) => {
        const removed = withStore((store) => store.removeContent(id, "tool.remove"));
        return {
          content: [
            { type: "text", text: removed ? `queued removal of ${id}` : `${id} not found` },
          ],
        };
      },
    },
    {
      name: "list_mirror_content",
      description:
        "List the current page, presentation revision, and all active typed content. Call before a redesign or when updating an existing item.",
      inputSchema: z.object({}),
      handler: async () => {
        const snapshot = withStore((store) => store.snapshot());
        const lines = snapshot.contents.map((item) => summarizeContent(item));
        return {
          content: [
            {
              type: "text",
              text: [
                `revision=${snapshot.revision} page=${snapshot.page} rotation=${snapshot.rotation}`,
                ...(lines.length > 0 ? lines : ["(no content)"]),
              ].join("\n"),
            },
          ],
        };
      },
    },
    {
      name: "set_mirror_page",
      description:
        "Switch the active mirror page. Content on page '*' remains visible on every page.",
      inputSchema: z.object({
        page: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/),
      }),
      handler: async ({ page }) => {
        const revision = withStore((store) => store.setPage(page, "tool.page"));
        return { content: [{ type: "text", text: `queued page ${page} at revision ${revision}` }] };
      },
    },
    {
      name: "set_mirror_rotation",
      description:
        "Set the mirror display orientation in degrees. This is durable across reconnects and restarts.",
      inputSchema: z.object({
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      }),
      handler: async ({ rotation }) => {
        const revision = withStore((store) => store.setRotation(rotation, "tool.rotation"));
        return {
          content: [
            {
              type: "text",
              text: `queued mirror rotation ${rotation}° at revision ${revision}`,
            },
          ],
        };
      },
    },
    {
      name: "reset_mirror_baseline",
      description:
        "Recover the mirror to its known-good baseline. Removes all custom ephemeral, session, and persistent content, returns to home, and preserves the protected clock/date fixtures.",
      inputSchema: z.object({
        confirm: z
          .boolean()
          .describe("Must be true. This intentionally removes all custom persistent content too."),
      }),
      handler: async ({ confirm }) => {
        if (!confirm) {
          return {
            content: [{ type: "text", text: "not reset: confirm must be true" }],
            isError: true,
          };
        }
        const result = withStore((store) => store.resetToBaseline("tool.reset"));
        return {
          content: [
            {
              type: "text",
              text: `queued baseline reset at revision ${result.revision}; removed ${result.removed.length} item(s)`,
            },
          ],
        };
      },
    },
    {
      name: "show_mirror_overlay",
      description:
        "Show bounded plain text in the active voice overlay. This is transient interaction state, not durable dashboard content.",
      inputSchema: z.object({
        phase: z.enum(["idle", "listening", "thinking", "speaking", "showing"]).default("showing"),
        text: z.string().trim().max(4_000).optional(),
      }),
      handler: async ({ phase, text }) => {
        const id = mirrorFrameId("overlay");
        withStore((store) =>
          store.enqueueCommand({
            v: 2,
            id,
            type: "overlay_set",
            overlay: {
              phase,
              ...(text ? { botText: text } : {}),
            },
          }),
        );
        return { content: [{ type: "text", text: `overlay queued (${id})` }] };
      },
    },
    {
      name: "push_mirror_asset",
      description:
        "Upload an image, video, audio file, PDF, or other bounded artifact from the current sandbox to the mirror. Returns a local mirror asset URL for a typed component. For images it also returns a MEASURED `treatment` (photo or chart) — copy it straight into the image_card rather than judging it yourself; it comes from the actual pixels, and a map or chart shown as a photo is a lit rectangle in a dark room. Prefer send_attachment when the intent is simply to show/deliver the file.",
      inputSchema: z.object({
        file_path: z
          .string()
          .describe("Absolute path under an allowed Edmund sandbox/output root."),
      }),
      handler: async ({ file_path }) => {
        const path = resolve(file_path);
        assertPathSafe(path);
        const asset = await publishMirrorAsset(path, ctx.config);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(asset),
            },
          ],
        };
      },
    },
    {
      name: "speak_on_mirror",
      description:
        "Speak one brief plain-language line during a voice conversation. It is suppressed outside a recent user-opened voice volley. The text is also captioned, so speech is never the only copy.",
      inputSchema: z.object({
        text: z.string().trim().min(1).max(1_000),
      }),
      handler: async ({ text }) => {
        const id = withStore((store) => store.enqueueLocalSpeak(text));
        return { content: [{ type: "text", text: `speech queued (${id})` }] };
      },
    },
    {
      name: "mirror_widget_state_get",
      description: "Read one structured state value for a persistent mirror tracker/widget.",
      inputSchema: StateKeyInput,
      handler: async ({ widget_id, key }) => {
        const value = withStore((store) => store.getWidgetState(widget_id, key));
        return {
          content: [
            {
              type: "text",
              text: value === undefined ? "not set" : JSON.stringify(value),
            },
          ],
        };
      },
    },
    {
      name: "mirror_widget_state_set",
      description:
        "Write one JSON state value for a persistent mirror tracker/widget. Then call update_mirror_content when its visible projection also needs to change.",
      inputSchema: StateKeyInput.extend({
        value: z.unknown(),
        value_type: z.enum(["json", "string", "number", "boolean", "datetime"]).default("json"),
      }),
      handler: async ({ widget_id, key, value, value_type }) => {
        withStore((store) => store.setWidgetState(widget_id, key, value, value_type));
        return { content: [{ type: "text", text: `saved ${widget_id}.${key}` }] };
      },
    },
    {
      name: "list_mirror_mutations",
      description:
        "Read the recent bounded mirror mutation audit trail for diagnosis or undo planning.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25),
      }),
      handler: async ({ limit }) => {
        const rows = withStore((store) => store.listAudit(limit));
        return {
          content: [
            {
              type: "text",
              text:
                rows.length === 0
                  ? "(no mutations)"
                  : rows
                      .map(
                        (row) =>
                          `${row.id} r${row.revision} ${row.action}${row.targetId ? ` ${row.targetId}` : ""} ${new Date(row.createdAtMs).toISOString()}`,
                      )
                      .join("\n"),
            },
          ],
        };
      },
    },
    {
      name: "set_refresh_script",
      description:
        "Author a DETERMINISTIC refresh for a recurring widget update — replaces a model-turn cron for pure fetch→render refreshes (weather, scores, prices). You write an async JS function BODY once (bun runtime, global `fetch` available); the daemon runs it on the given interval for FREE — no model turn — and applies whatever it returns as an update_mirror_content call. The body MUST `return` the complete update args object: {id, page, zone, presentation, lifespan?, priority?, component, props}. It is validated by running once RIGHT NOW (which also refreshes the widget); a broken script never arms. Re-arming the same name replaces the old script. If the script starts failing, you get woken with the error to fix it — until then, zero tokens per refresh. After arming, CANCEL the old refresh cron for this widget if one exists.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(60)
          .describe("Stable name, e.g. 'weather-widget'. Re-use to replace."),
        brief: z
          .string()
          .min(1)
          .describe(
            "What this refresh maintains + data source + shape notes. Context for future-you when repairing it.",
          ),
        script: z
          .string()
          .min(1)
          .describe(
            "Async JS function body. Example: const r = await fetch('https://api.weather.gov/...', {headers:{'User-Agent':'edmund-harness'}}); const d = await r.json(); return {id:'weather', page:'home', zone:'top_right', presentation:'widget', lifespan:{mode:'persistent'}, component:'…', props:{…}};",
          ),
        interval_minutes: z
          .number()
          .int()
          .min(5)
          .max(1440)
          .default(60)
          .describe("Refresh cadence. Match the data's tempo."),
      }),
      handler: async (args) => {
        if (hostAccess(ctx.config) !== "full") {
          return {
            content: [
              {
                type: "text" as const,
                text: 'refresh scripts are model-authored code run on the daemon, and this deployment keeps the model off the host ([security].model_host_access = "sandboxed"). Use a scheduled model turn instead.',
              },
            ],
            isError: true,
          };
        }
        if (!isMirrorSession(ctx.sessionKey)) {
          return err("refresh scripts are only available in a Mirror session");
        }
        const store = new RefreshScriptStore(ctx.dataDir);
        try {
          if (
            store.countArmedBySession(ctx.sessionKey) >= 10 &&
            !store.findArmedByName(ctx.sessionKey, args.name)
          ) {
            return err("this session already has 10 armed refresh scripts — cancel one first");
          }
          // Validate by running for real: script executes in the sandboxed
          // subprocess, output must pass the update_mirror_content schema,
          // and the apply lands NOW (fresh widget + proven end-to-end).
          const run = await runRefreshScriptSource(args.script);
          if (!run.ok) {
            return err(`script NOT armed — first run failed: ${run.error}. Fix and retry.`);
          }
          const applied = applyMirrorRefresh(ctx.dataDir, ctx.config, run.value);
          if (!applied.ok) {
            return err(`script NOT armed — ${applied.error}. Fix the returned object and retry.`);
          }
          const prior = store.findArmedByName(ctx.sessionKey, args.name);
          if (prior) store.cancel(prior.id, ctx.sessionKey);
          const s = store.create({
            sessionKey: ctx.sessionKey,
            name: args.name,
            brief: args.brief,
            script: args.script,
            applyKind: "mirror_content",
            intervalMs: args.interval_minutes * 60_000,
          });
          return ok(
            [
              `armed refresh script ${s.id} (${s.name}) — every ${args.interval_minutes}m, zero model turns.${prior ? ` Replaced ${prior.id}.` : ""}`,
              `First run applied clean: ${applied.summary}`,
              `If a cron currently refreshes this widget via a model turn, cancel it now — the script owns the refresh.`,
            ].join("\n"),
          );
        } finally {
          store.close();
        }
      },
    },
    {
      name: "list_refresh_scripts",
      description:
        "List this session's deterministic refresh scripts: cadence, last run/apply, and any lastError (a persistently failing script needs a rewrite via set_refresh_script or retirement via cancel_refresh_script).",
      inputSchema: z.object({}),
      handler: async () => {
        const store = new RefreshScriptStore(ctx.dataDir);
        try {
          const all = store.listBySession(ctx.sessionKey);
          if (all.length === 0) return ok("no refresh scripts");
          const lines = all.map((s) => {
            const failing =
              s.consecutiveFailures > 0 ? ` — FAILING ${s.consecutiveFailures}× (backing off)` : "";
            const last =
              s.lastOkMs > 0 ? ` — last ok ${new Date(s.lastOkMs).toISOString()}` : " — never ran";
            const err_ = s.lastError ? `\n  LAST ERROR: ${s.lastError}` : "";
            return `• ${s.id} [${s.status}] ${s.name} — every ${Math.round(s.intervalMs / 60_000)}m${last}${failing}${err_}\n  brief: ${s.brief.slice(0, 140)}`;
          });
          return ok(lines.join("\n"));
        } finally {
          store.close();
        }
      },
    },
    {
      name: "cancel_refresh_script",
      description:
        "Retire a deterministic refresh script (the widget is gone, or the refresh should go back to being a model turn).",
      inputSchema: z.object({ script_id: z.string() }),
      handler: async ({ script_id }) => {
        const store = new RefreshScriptStore(ctx.dataDir);
        try {
          const s = store.get(script_id);
          if (!s || s.sessionKey !== ctx.sessionKey)
            return err(`no refresh script ${script_id} in this session`);
          return store.cancel(script_id, ctx.sessionKey)
            ? ok(`canceled ${script_id} (${s.name})`)
            : err(`refresh script ${script_id} is already ${s.status}`);
        } finally {
          store.close();
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

export function toContentInput(
  args: z.infer<typeof RenderInput> & { id: string },
  defaultTtlSeconds: number,
): MirrorContentInput {
  // The intent decides all four layout fields; anything stated explicitly
  // wins over what it chose.
  //
  // This is also what keeps every caller written before intents existed
  // working unchanged. `intent` defaults to "answer", whose resolved fields
  // are widget / ephemeral / 0 — byte for byte the per-field defaults these
  // four used to carry. A refresh script that sends only a zone therefore
  // lands exactly where it always did, and one that sends all four overrides
  // all four.
  const chosen = placementForIntent(args.intent, args.component);
  const zone = args.zone ?? chosen.zone;
  const presentation = args.presentation ?? chosen.presentation;
  const mode = args.lifespan?.mode ?? chosen.lifespan;
  const priority = args.priority ?? chosen.priority;
  const ttl = mode === "ephemeral" ? (args.lifespan?.ttl_seconds ?? defaultTtlSeconds) : null;

  return {
    id: args.id,
    page: args.page,
    // Legibility outranks intent, and this runs last so it applies either
    // way: an "ambient" list_card is still prose, and prose in a corner
    // column wraps at about seven characters a line. It comes out in a
    // full-width band at ambient priority, which is the sane reading of the
    // request rather than an error to argue with.
    zone: placementZone(zone, args.component),
    presentation,
    component: args.component,
    props: args.props,
    lifespan: mode,
    priority,
    expiresAtMs: ttl == null ? null : Date.now() + ttl * 1_000,
  } as MirrorContentInput;
}

function safeContentId(component: string): string {
  const suffix = genId("content").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${component}:${suffix}`.slice(0, 80);
}
