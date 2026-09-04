import type { Config } from "../config/config.ts";
import type { InboundMessage } from "../imessage/types.ts";
import {
  type ContactResolver,
  type SessionKey,
  orchKeyFor,
  orchestratorOfSession,
  sessionKeyFor,
} from "../sessions/key.ts";

/**
 * Named-orchestrator registry — the single place that answers "which
 * personas exist, who is primary, and who does this message invoke?".
 *
 * The built-in main persona (top-level persona/*.md, invoked by
 * [identity].names) is always present as the synthetic entry `key: "main"`.
 * Config [[orchestrators]] entries add more. Exactly one orchestrator is
 * primary at any time: a config entry with role="primary" if one exists,
 * otherwise main. Primary receives un-named DMs; everyone else is invoked
 * strictly by name (same per-message, no-stickiness model as the trading
 * router in integrations/trading/src/route.ts).
 */
export type Orchestrator = {
  key: string;
  name: string;
  invocations: string[];
  role: "primary" | "secondary";
  /** Model override; "" = inherit config.claude.model. */
  model: string;
  /** True for the synthetic main entry (top-level persona files). */
  builtin: boolean;
};

function listOrchestrators(config: Config): Orchestrator[] {
  const entries = config.orchestrators;
  const configuredPrimary = entries.some((e) => e.role === "primary");
  const main: Orchestrator = {
    key: "main",
    name: displayNameFromInvocation(config.identity.names[0] ?? "claude"),
    invocations: config.identity.names,
    role: configuredPrimary ? "secondary" : "primary",
    model: "",
    builtin: true,
  };
  return [
    main,
    ...entries.map((e) => ({
      key: e.key,
      name: e.name,
      invocations: e.invocations,
      role: e.role,
      model: e.model,
      builtin: false,
    })),
  ];
}

export function primaryOrchestrator(config: Config): Orchestrator {
  const all = listOrchestrators(config);
  return all.find((o) => o.role === "primary") ?? all[0]!;
}

function orchestratorByKey(config: Config, key: string): Orchestrator | null {
  return listOrchestrators(config).find((o) => o.key === key) ?? null;
}

/** Every invocation word across all orchestrators — the group-chat mention
 *  gate accepts a message when ANY of these is named. */
export function allInvocationNames(config: Config): string[] {
  return listOrchestrators(config).flatMap((o) => o.invocations);
}

/**
 * Which orchestrator does this text invoke by name? Whole-word or @mention,
 * case-insensitive; when several names appear, the EARLIEST mention in the
 * text wins ("desmond, edmund said hi" → desmond). Returns null when no
 * orchestrator is named — callers then route to the primary (DMs) or rely
 * on the mention gate having already dropped the message (groups).
 */
export function matchOrchestrator(text: string, config: Config): Orchestrator | null {
  const lower = (text ?? "").toLowerCase();
  if (!lower) return null;
  let best: { orch: Orchestrator; index: number } | null = null;
  for (const orch of listOrchestrators(config)) {
    for (const inv of orch.invocations) {
      const n = inv.trim().toLowerCase();
      if (!n) continue;
      const re = new RegExp(`(?:@|\\b)${escapeRegex(n)}\\b`);
      const m = re.exec(lower);
      if (m && (best === null || m.index < best.index)) {
        best = { orch, index: m.index };
      }
    }
  }
  return best?.orch ?? null;
}

/**
 * Which orchestrator should handle this fresh inbound? Named orchestrator
 * if the text invokes one, otherwise the primary. With no [[orchestrators]]
 * configured this is always main — the zero-config fast path.
 */
export function routeForMessage(text: string, config: Config): Orchestrator {
  if (config.orchestrators.length === 0) return primaryOrchestrator(config);
  return matchOrchestrator(text, config) ?? primaryOrchestrator(config);
}

/**
 * Session key for an orchestrator+message. Main keeps the legacy
 * un-prefixed `imessage:` keys (existing session memory survives, and an
 * empty-config deployment is byte-identical); everyone else lives under
 * `orch:<key>:`.
 */
export function sessionKeyForOrchestrator(
  orch: Orchestrator,
  msg: InboundMessage,
  contacts?: ContactResolver,
): SessionKey {
  return orch.key === "main" ? sessionKeyFor(msg, contacts) : orchKeyFor(orch.key, msg, contacts);
}

/**
 * Invocation names for the orchestrator that owns this session — what the
 * mention-strip and the post-transcribe re-gate should match against.
 * Non-orchestrator namespaces (trading, cron) fall back to identity.names.
 */
export function invocationsForSession(sessionKey: SessionKey, config: Config): string[] {
  const okey = orchestratorOfSession(sessionKey);
  if (!okey || okey === "main") return config.identity.names;
  return orchestratorByKey(config, okey)?.invocations ?? config.identity.names;
}

/**
 * The orchestrator a session belongs to: the synthetic main entry for
 * legacy `imessage:` keys, the matching config entry for `orch:` keys, and
 * null for non-orchestrator namespaces (trading, cron) or an `orch:` key
 * whose config entry has been deleted.
 */
export function orchestratorForSession(
  sessionKey: SessionKey,
  config: Config,
): Orchestrator | null {
  const okey = orchestratorOfSession(sessionKey);
  return okey ? orchestratorByKey(config, okey) : null;
}

function displayNameFromInvocation(inv: string): string {
  const t = inv.trim();
  return t.length > 0 ? t[0]!.toUpperCase() + t.slice(1) : "Main";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
