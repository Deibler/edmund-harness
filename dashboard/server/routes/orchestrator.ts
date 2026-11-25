import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import { invalidateConfig } from "../config.ts";
import { readConfigRaw, writeConfig } from "../services/configIO.ts";

/** The persona files the settings page lists and edits. */
const PERSONA_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "VENUE_DM.md",
  "VENUE_GROUP.md",
  "VENUE_MIRROR.md",
  "HOME.md",
] as const;

/**
 * Orchestrator — the model-system control surface.
 *
 * One place to see and edit each subsystem's Claude Code model and the
 * persona files that make up the operator's system prompt.
 */

const SUBSYSTEM_KEYS = ["operator", "ghost", "people_maintainer", "agents"] as const;
type SubsystemKey = (typeof SUBSYSTEM_KEYS)[number];

/** Where each subsystem's primary model lives in config.toml. */
const MODEL_PATHS: Record<SubsystemKey, [string, string]> = {
  operator: ["claude", "model"],
  ghost: ["brown_nose", "ghost_model"],
  people_maintainer: ["people_maintainer", "model"],
  agents: ["claude", "agent_model"],
};

const SUBSYSTEM_INFO: Record<
  SubsystemKey,
  { label: string; description: string; personaFiles: string[] }
> = {
  operator: {
    label: "Operator",
    description:
      "The main conversation model — every iMessage turn, tool call, and reply runs on it.",
    personaFiles: ["IDENTITY.md", "SOUL.md", "AGENTS.md", "VENUE_DM.md", "VENUE_GROUP.md"],
  },
  ghost: {
    label: "Ghost (brown-nose)",
    description:
      "Proactive-outreach decider behind each chat — picks if and when the operator gets woken unprompted.",
    personaFiles: ["GHOST.md"],
  },
  people_maintainer: {
    label: "People maintainer",
    description:
      "Background pass that keeps person and group memory files current after each reply.",
    personaFiles: [],
  },
  agents: {
    label: "Sub-agents",
    description:
      "Detached research workers spawned by the agent tool — multi-step research, analysis, pipelines.",
    personaFiles: [],
  },
};

function getPath(obj: Record<string, unknown>, [section, key]: [string, string]): string {
  const sec = obj[section];
  if (sec && typeof sec === "object") {
    const v = (sec as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return "";
}

function identityNames(raw: Record<string, unknown>): string[] {
  const id = raw.identity as Record<string, unknown> | undefined;
  const names = Array.isArray(id?.names)
    ? id.names.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  return names.length > 0 ? names : ["claude"];
}

/** Trim, lowercase, dedupe; drops empties. Stored lowercase — the matcher
 *  is case-insensitive anyway, and one canonical form keeps conflict checks
 *  trivially correct. */
function normInvocations(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function orchestratorRoutes(opts: { repoRoot: string }): Hono {
  const app = new Hono();
  const personaDir = resolve(opts.repoRoot, "persona");

  const personaPathFor = (name: string): string | null => {
    // Top-level persona/*.md only — no separators, no traversal, .md required.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/.test(name)) return null;
    const path = resolve(personaDir, name);
    if (dirname(path) !== personaDir) return null;
    return path;
  };

  /** Which of the persona files exist. */
  const personaStatus = () =>
    PERSONA_FILES.map((file) => {
      const shared = resolve(personaDir, file);
      if (existsSync(shared)) {
        const st = statSync(shared);
        return { file, source: "shared" as const, size: st.size, mtimeMs: st.mtimeMs };
      }
      return { file, source: "missing" as const, size: 0, mtimeMs: 0 };
    });

  const backupFile = (path: string, label: string): string | null => {
    if (!existsSync(path)) return null;
    const backupDir = resolve(personaDir, ".backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = resolve(backupDir, `${label}.${stamp}`);
    writeFileSync(backup, readFileSync(path));
    return backup;
  };

  // GET / → full orchestrator summary
  app.get("/", async (c) => {
    const raw = readConfigRaw();

    const operatorModel = getPath(raw as Record<string, unknown>, MODEL_PATHS.operator);
    const subsystems = SUBSYSTEM_KEYS.map((key) => {
      const info = SUBSYSTEM_INFO[key];
      const model = getPath(raw as Record<string, unknown>, MODEL_PATHS[key]);
      return {
        key,
        label: info.label,
        description: info.description,
        personaFiles: info.personaFiles,
        model,
        effectiveModel: model,
        inheritsOperator: false,
      };
    });

    // One persona, listed the way the settings page expects a list.
    const mainNames = identityNames(raw as Record<string, unknown>);
    const orchestrators = [
      {
        key: "main",
        name: mainNames[0] ? mainNames[0][0]!.toUpperCase() + mainNames[0].slice(1) : "Main",
        invocations: mainNames,
        role: "primary" as const,
        builtin: true,
        model: operatorModel,
        effectiveModel: operatorModel,
        inheritsOperator: false,
        persona: personaStatus(),
      },
    ];

    const claude = (raw.claude as Record<string, unknown>) ?? {};
    const compactRaw = (claude.auto_compact as Record<string, unknown>) ?? {};
    const compact = {
      enabled: compactRaw.enabled !== false,
      threshold_tokens:
        typeof compactRaw.threshold_tokens === "number" ? compactRaw.threshold_tokens : 800_000,
    };
    const effort = typeof claude.effort === "string" ? claude.effort : "high";

    let personaFiles: Array<{ name: string; size: number; mtimeMs: number }> = [];
    try {
      personaFiles = readdirSync(personaDir)
        .filter((f) => f.endsWith(".md"))
        .map((name) => {
          const st = statSync(resolve(personaDir, name));
          return { name, size: st.size, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // persona dir missing — leave empty
    }

    return c.json({
      subsystems,
      orchestrators,
      compact,
      effort,
      personaFiles,
    });
  });

  // PUT /subsystem/:key { model } → writes config.toml
  app.put("/subsystem/:key", async (c) => {
    const key = c.req.param("key") as SubsystemKey;
    if (!SUBSYSTEM_KEYS.includes(key)) return c.json({ error: "unknown subsystem" }, 400);
    const body = (await c.req.json().catch(() => null)) as { model?: string } | null;
    if (!body || body.model === undefined) return c.json({ error: "model required" }, 400);
    if (body.model.includes("/")) {
      return c.json({ error: "conversation models must be Claude Code models" }, 400);
    }

    try {
      const current = readConfigRaw();
      const merged: Record<string, unknown> = { ...current };
      const [section, k] = MODEL_PATHS[key];
      const sec = { ...((merged[section] as Record<string, unknown>) ?? {}) };
      sec[k] = body.model.trim();
      merged[section] = sec;

      const { backupPath } = await writeConfig(merged);
      invalidateConfig();
      return c.json({ ok: true, backup: backupPath });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // PUT /orchestrators/main — the built-in persona's names and model.
  // invocations → [identity].names, model → [claude].model. The route keeps
  // its :key so the settings page addresses the persona the way it lists it.
  app.put("/orchestrators/:key", async (c) => {
    if (c.req.param("key") !== "main") return c.json({ error: "no such persona" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      invocations?: string[];
      model?: string;
    } | null;
    if (!body) return c.json({ error: "invalid JSON body" }, 400);

    const raw = readConfigRaw();
    const merged: Record<string, unknown> = { ...raw };
    if (body.model?.includes("/")) {
      return c.json({ error: "conversation models must be Claude Code models" }, 400);
    }
    if (body.invocations !== undefined) {
      const invocations = normInvocations(body.invocations);
      if (invocations.length === 0) {
        return c.json({ error: "at least one invocation name required" }, 400);
      }
      merged.identity = {
        ...((merged.identity as Record<string, unknown>) ?? {}),
        names: invocations,
      };
    }
    if (body.model !== undefined) {
      merged.claude = {
        ...((merged.claude as Record<string, unknown>) ?? {}),
        model: body.model.trim(),
      };
    }

    try {
      const { backupPath } = await writeConfig(merged);
      invalidateConfig();
      return c.json({ ok: true, requiresRestart: true, backup: backupPath });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // GET /persona/:name → { name, content }
  app.get("/persona/:name", (c) => {
    const path = personaPathFor(c.req.param("name"));
    if (!path) return c.json({ error: "invalid persona file name" }, 400);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    return c.json({ name: c.req.param("name"), content: readFileSync(path, "utf8") });
  });

  // PUT /persona/:name { content } → write with timestamped backup
  app.put("/persona/:name", async (c) => {
    const name = c.req.param("name");
    const path = personaPathFor(name);
    if (!path) return c.json({ error: "invalid persona file name" }, 400);
    const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
    if (typeof body?.content !== "string") return c.json({ error: "content required" }, 400);
    if (body.content.length > 512 * 1024) return c.json({ error: "content too large" }, 400);

    try {
      let backup: string | null = null;
      if (existsSync(path)) {
        const backupDir = resolve(personaDir, ".backups");
        mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        backup = resolve(backupDir, `${name}.${stamp}`);
        writeFileSync(backup, readFileSync(path));
      }
      writeFileSync(path, body.content, "utf8");
      return c.json({ ok: true, backup });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}
