#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { configureSendVerification } from "../imessage/actions/verify.ts";
import { invoke } from "../imessage/bridge/index.ts";
import { collectIntegrationTools } from "../integrations/host.ts";
import { initRegistryFromConfig } from "../integrations/registry.ts";
import { isSubagentSession } from "../sessions/key.ts";
import { installLogSinkFromEnv } from "../util/log-sink.ts";
import { humanMs, log, snippet } from "../util/log.ts";
import { type ToolContext, loadToolContext } from "./context.ts";
import { protectStdout } from "./stdio-safety.ts";
import { agentTools } from "./tools/agents.ts";
import { annotateTools } from "./tools/annotate.ts";
import { backgroundTools } from "./tools/background.ts";
import { brownNoseTools } from "./tools/brown-nose.ts";
import { contactsTools } from "./tools/contacts.ts";
import { cronTools } from "./tools/cron.ts";
import { deepResearchTools } from "./tools/deep-research.ts";
import { errandTools } from "./tools/errands.ts";
import { generationTools } from "./tools/generation.ts";
import { historyTools } from "./tools/history.ts";
import { imessageActionTools } from "./tools/imessage-actions.ts";
import { memoryTools } from "./tools/memory.ts";
import { messageTools } from "./tools/message.ts";
import { missionTools } from "./tools/missions.ts";
import { personTools } from "./tools/person.ts";
import { semanticRecallTools } from "./tools/semantic-recall.ts";
import { skillRegistryTools } from "./tools/skill-registry.ts";
import { skillTools } from "./tools/skills.ts";
import { triggerTools } from "./tools/triggers.ts";
import type { ToolDef } from "./tools/types.ts";
import { typingTools } from "./tools/typing.ts";
import { videoTools } from "./tools/video.ts";
import { voiceTools } from "./tools/voice.ts";
import { webTools } from "./tools/web.ts";
import { zodToJsonSchema } from "./zod-to-json.ts";

async function main() {
  // MUST run before anything else can write: stdout is the JSON-RPC transport.
  protectStdout();
  // Install log sink BEFORE loading context so any startup errors (missing
  // env, bad config) surface in daemon.log. Prefix with the session key so
  // tool calls are attributable in the shared file when multiple sessions
  // run concurrently.
  const rawSessionKey = process.env.EDMUND_SESSION_KEY ?? "?";
  installLogSinkFromEnv(`mcp[${shortKey(rawSessionKey)}] `);

  const ctx = loadToolContext();
  initRegistryFromConfig(ctx.config);

  // The same send verification and self-route recovery the daemon has. Without
  // this, an MCP send that resolved into our own thread failed on first
  // detection with no recovery — which is what taught the model to bounce
  // Messages by hand around every send. The heal itself runs in the daemon
  // (only the daemon supervises Messages); this process requests it over the
  // control socket and rides whatever relaunch the daemon coalesces.
  configureSendVerification({
    chatDbPath: ctx.config.paths.chat_db,
    selfHandles: ctx.config.self.handles,
    onMisdelivery: async (event) => {
      const { outcome } = await invoke("healRegistry", {
        reason: `${event.intended} → ${event.landedIdentifier}`,
      });
      return outcome;
    },
    onUnrecovered: (event) => {
      log.error("send-verify", "message lost to a self-route after every recovery round", {
        intended: event.intended,
        landed: event.landedIdentifier,
      });
    },
  });

  const tools: ToolDef[] = assembleCoreTools(ctx);

  // Integration tools. Each installed package declares its tool factories in
  // `manifest.yaml`; the registry imports only the ones enabled for this
  // deployment and access-filters them against THIS session. That is what
  // keeps Robinhood tools inside `trading:` sessions and the ~13 glass tools
  // inside `mirror:` — the gate is declarative, not a per-tool `if`.
  //
  // An integration that is not installed contributes nothing and costs nothing:
  // no import is attempted, so deleting a package is a supported configuration.
  //
  // Guest tiers get NO integration tools at all — one gate here beats
  // teaching every manifest a "guest" scope, and it fails closed for
  // integrations installed later.
  if (ctx.guestTier == null) {
    tools.push(
      ...(await collectIntegrationTools<ToolDef>(
        ctx,
        {
          sessionKey: ctx.sessionKey,
          handle: process.env.EDMUND_SENDER_HANDLE ?? null,
          isAgent: process.env.EDMUND_AGENT === "1",
        },
        ctx.config,
      )),
    );
  }
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "edmund-harness", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, t.name),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = toolMap.get(name);
    if (!tool) {
      log.warn("tool", "unknown tool", { name });
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    const rawArgs = normalizeAliases(req.params.arguments ?? {}, tool.inputSchema);
    log.info("tool", `→ ${name}`, { args: summarizeArgs(rawArgs) });
    log.debug("tool", `args-full ${name}`, { args: redactSecrets(rawArgs) });
    const started = Date.now();
    try {
      const args = tool.inputSchema.parse(rawArgs);
      const result = await tool.handler(args);
      const duration = Date.now() - started;
      const isError = Boolean(result.isError);
      const replyText = extractText(result);
      log.info("tool", `${isError ? "✗" : "✓"} ${name}`, {
        dur: humanMs(duration),
        reply: snippet(replyText, 200),
      });
      return result;
    } catch (err) {
      const duration = Date.now() - started;
      // Zod errors as raw `.message` are a long JSON dump; the model
      // wastes a follow-up turn trying to parse them. Reformat to a
      // single-line "field X: reason" list and surface the schema's
      // expected fields so the model can self-correct in one shot.
      const msg =
        err instanceof z.ZodError
          ? formatZodError(err, tool.inputSchema)
          : err instanceof Error
            ? err.message
            : String(err);
      log.error("tool", `✗ ${name} threw`, { dur: humanMs(duration), err: msg });
      return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

/**
 * The in-repo server's tool list for one session. Exported so tests can
 * assert the loadout structurally (guest sessions must simply not have the
 * excluded tools — see docs/design/guest-access-plan.md).
 *
 * Two session-shaped reductions:
 *  - sub-agents lose spawn/handoff/deep-research (depth cap);
 *  - guest tiers keep only the conversational surface: this-chat messaging
 *    and typing, media understanding/generation, voice, web, and background
 *    jobs. Everything that reads the operator's world (history, semantic
 *    recall, person files, memory, contacts, annotations, brown-nose),
 *    schedules future work (cron, triggers, missions, errands), spawns
 *    agents, or executes skills is not registered at all.
 */
/**
 * Tools an allowlisted contact does not get under [security].contact_tier =
 * "contact". Everything here either reaches another person (relay, errands,
 * the contact list), writes memory every conversation reads (SOUL, domain
 * notes), searches every person's file, or changes what other chats can run
 * (publishing, installing). The reduction is by name so the list is the
 * whole policy and a test can pin it.
 */
export const CONTACT_TIER_EXCLUDED = new Set([
  "list_contacts",
  "message_contact",
  "ask_contact",
  "report_errand",
  "list_errands",
  "cancel_errand",
  "remember_about_self",
  "update_self_memory",
  "remember_about_subject",
  "memory_search",
  "publish_skill",
  "unpublish_skill",
  "install_skill",
  "uninstall_skill",
]);

export function assembleCoreTools(ctx: ToolContext): ToolDef[] {
  const tools = assembleByTier(ctx);
  if (ctx.sessionTier === "contact") return tools.filter((t) => !CONTACT_TIER_EXCLUDED.has(t.name));
  return tools;
}

function assembleByTier(ctx: ToolContext): ToolDef[] {
  const subagent = isSubagentSession(ctx.sessionKey);
  const guest = ctx.guestTier != null;

  return [
    ...(guest ? [] : cronTools(ctx)),
    ...(guest ? [] : historyTools(ctx)),
    ...(guest ? [] : semanticRecallTools(ctx)),
    ...(guest ? [] : personTools(ctx)),
    ...voiceTools(ctx),
    ...videoTools(ctx),
    ...messageTools(ctx),
    // send_message/send_attachment/react above are this-chat scoped and stay.
    // The cross-chat and shared-surface actions (create_chat, group
    // management, edit/unsend) go with the rest of the imessage actions.
    ...(guest ? [] : imessageActionTools(ctx)),
    ...(guest ? [] : skillTools(ctx)),
    ...(guest ? [] : skillRegistryTools(ctx)),
    ...typingTools(ctx),
    ...(subagent || guest ? [] : agentTools(ctx)),
    ...(subagent || guest ? [] : deepResearchTools(ctx)),
    ...(guest ? [] : annotateTools(ctx)),
    ...generationTools(ctx),
    ...webTools(ctx),
    ...(guest ? [] : memoryTools(ctx)),
    ...backgroundTools(ctx),
    ...(guest ? [] : contactsTools(ctx)),
    ...(guest ? [] : errandTools(ctx)),
    ...(guest ? [] : missionTools(ctx)),
    ...(guest ? [] : triggerTools(ctx)),
    ...(guest ? [] : brownNoseTools(ctx)),
  ];
}

/**
 * Compact args for the one-liner log. Full args are in the DEBUG line
 * right below. Long strings are shortened, binary-ish fields are shown
 * only as length, and secret-ish keys are redacted by log.ts.
 */
/**
 * Common aliases the model reaches for when it doesn't recall the exact
 * field name. Renames in-place ONLY when the canonical key isn't already
 * present, so a tool that legitimately defines `path` keeps working.
 *
 * Triggered by the real 2026-05-17 incident: model called send_attachment
 * with `{"path": "..."}` instead of `{"file_path": "..."}`, ate a Zod
 * error, retried 3s later with the right key. This eliminates the
 * common single-field-name-guess class of papercut entirely.
 */
// Trimmed to the path-family — the only aliases backed by a real
// incident (2026-05-17 send_attachment papercut). Earlier revisions
// included speculative renames like `query → prompt`, `body → text`,
// `image → image_path` etc.; even with the schema-aware guard they
// were a footgun (the brave web_search call on 2026-05-18 was the
// canary). Add new entries here ONLY when the model actually got
// caught reaching for an alias in the logs, not preemptively.
const TOOL_ALIASES: Record<string, string> = {
  path: "file_path",
  filepath: "file_path",
};

function normalizeAliases(args: unknown, schema: z.ZodTypeAny): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  const src = args as Record<string, unknown>;
  // Only rewrite aliases when the canonical field actually exists on THIS
  // tool's schema (and the alias does not). Otherwise an alias like
  // `query → prompt` would silently strip the legit `query` arg from
  // tools like web_search whose schema defines `query`, not `prompt` —
  // exactly the failure mode caught on 2026-05-18 in the daemon log.
  // biome-ignore lint/suspicious/noExplicitAny: zod runtime shape isn't typed
  const def: any = (schema as any)._def;
  const shape: Record<string, unknown> | undefined = def?.shape?.() ?? def?.shape ?? undefined;
  if (!shape) return src;
  let out: Record<string, unknown> | null = null;
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    if (alias in src && !(canonical in src) && canonical in shape && !(alias in shape)) {
      if (!out) out = { ...src };
      out[canonical] = out[alias];
      delete out[alias];
    }
  }
  return out ?? src;
}

/**
 * Render a Zod error as a single line the model can act on, plus the
 * canonical field names of the tool's schema so it knows what to retry
 * with. ZodError's `.message` is a multi-line JSON dump that costs tokens
 * and obscures the actual problem.
 */
function formatZodError(err: z.ZodError, schema: z.ZodTypeAny): string {
  const issues = err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    })
    .join("; ");
  const expectedFields = describeSchemaFields(schema);
  const tail = expectedFields ? ` — expected fields: ${expectedFields}` : "";
  return `invalid arguments: ${issues}${tail}`;
}

function describeSchemaFields(schema: z.ZodTypeAny): string {
  // We only expose the top-level shape; nested objects are still in the
  // issue path. Good enough to disambiguate the common "wrong field name"
  // mistake without dumping the whole schema.
  // biome-ignore lint/suspicious/noExplicitAny: zod's runtime shape isn't typed in public API
  const def: any = (schema as any)._def;
  const shape: Record<string, z.ZodTypeAny> | undefined = def?.shape?.() ?? def?.shape ?? undefined;
  if (!shape) return "";
  const names: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const isOptional = (v as any).isOptional?.() === true;
    names.push(isOptional ? `${k}?` : k);
  }
  return names.join(", ");
}

const SECRET_ARG_RE = /(^|_)(key|token|secret|password|passwd|authorization|api_key|cookie)($|_)/i;

/**
 * Replace credential-shaped values at any depth. A tool argument named
 * `token` or `api_key` is a secret whatever tool it belongs to, and the
 * daemon log is read by more eyes than the config file.
 */
export function redactSecrets(value: unknown, keyName = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, keyName));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = redactSecrets(v, k);
    return out;
  }
  if (
    typeof value === "string" &&
    SECRET_ARG_RE.test(keyName) &&
    !["session_key", "config_key"].includes(keyName)
  ) {
    return "***";
  }
  return value;
}

function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(redactSecrets(args) as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v.length > 120 ? `${v.slice(0, 120)}…(len=${v.length})` : v;
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length} items]`;
    } else if (v && typeof v === "object") {
      out[k] = "{obj}";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ");
}

function shortKey(key: string): string {
  // imessage:dm:+17175551234 → dm:+17175551234
  // imessage:group:any;+;a86... → group:a86…(6)
  return key.replace(/^imessage:/, "").replace(/^(group:)[\w;+]*([a-f0-9]{6})[a-f0-9]*/i, "$1$2…");
}

// Only when executed as the MCP server process — importing this module
// (tests asserting on assembleCoreTools) must not boot a server.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
