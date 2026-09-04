import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import { ORCH_PERSONA_FILES, orchFilePath } from "../../../src/claude/persona.ts";
import { invalidateConfig } from "../config.ts";
import { readConfigRaw, writeConfig } from "../services/configIO.ts";

/**
 * Orchestrator — the model-system control surface.
 *
 * One place to see and edit each subsystem's Claude Code model and the
 * persona files that make up the operator's system prompt.
 */

const SUBSYSTEM_KEYS = ["operator", "ghost", "people_maintainer", "trading", "agents"] as const;
type SubsystemKey = (typeof SUBSYSTEM_KEYS)[number];

/** Where each subsystem's primary model lives in config.toml. */
const MODEL_PATHS: Record<SubsystemKey, [string, string]> = {
  operator: ["claude", "model"],
  ghost: ["brown_nose", "ghost_model"],
  people_maintainer: ["people_maintainer", "model"],
  trading: ["trading", "model"],
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
  trading: {
    label: "Trading (Wolf)",
    description:
      "Autonomous trading sub-persona. Empty model inherits the operator's. Risk limits are code-enforced.",
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

// ─── Named orchestrators ([[orchestrators]] CRUD) ────────────────────────────

const ORCH_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** "main" + the builtin subsystem keys — never valid orchestrator keys. */
const RESERVED_ORCH_KEYS = new Set<string>(["main", ...SUBSYSTEM_KEYS]);

type OrchEntry = {
  key: string;
  name: string;
  invocations: string[];
  role: "primary" | "secondary";
  model: string;
};

function readOrchEntries(raw: Record<string, unknown>): OrchEntry[] {
  const arr = Array.isArray(raw.orchestrators) ? raw.orchestrators : [];
  return arr
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      key: typeof o.key === "string" ? o.key : "",
      name: typeof o.name === "string" ? o.name : "",
      invocations: Array.isArray(o.invocations)
        ? o.invocations.filter((i): i is string => typeof i === "string")
        : [],
      role: o.role === "primary" ? ("primary" as const) : ("secondary" as const),
      model: typeof o.model === "string" ? o.model : "",
    }))
    .filter((o) => o.key);
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

/** Which orchestrator already owns each candidate invocation? Includes the
 *  built-in main persona ([identity].names). `excludeKey` skips the entry
 *  being edited so renaming yourself isn't a self-conflict. */
function invocationConflicts(
  candidates: string[],
  raw: Record<string, unknown>,
  excludeKey: string | null,
): Array<{ invocation: string; owner: string; ownerName: string }> {
  const owners = new Map<string, { key: string; name: string }>();
  if (excludeKey !== "main") {
    for (const n of identityNames(raw)) {
      owners.set(n.trim().toLowerCase(), { key: "main", name: "main persona" });
    }
  }
  for (const e of readOrchEntries(raw)) {
    if (e.key === excludeKey) continue;
    for (const inv of e.invocations) {
      owners.set(inv.trim().toLowerCase(), { key: e.key, name: e.name || e.key });
    }
  }
  const out: Array<{ invocation: string; owner: string; ownerName: string }> = [];
  for (const inv of candidates) {
    const own = owners.get(inv.trim().toLowerCase());
    if (own) out.push({ invocation: inv, owner: own.key, ownerName: own.name });
  }
  return out;
}

function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function scaffoldIdentity(name: string, invocations: string[]): string {
  return [
    "# Identity",
    "",
    `You are ${name}. People invoke you by name in iMessage — any of: ${invocations.join(", ")}.`,
    "",
    "Keep replies in your own voice. You share chats with other personas — the primary persona answers un-named messages; only messages that name you are yours.",
    "",
    `_Scaffolded by the dashboard. Edit this file to give ${name} a real personality; every other persona file (SOUL, AGENTS, venue prompts) is inherited from the shared persona/ files until you add a custom override._`,
    "",
  ].join("\n");
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

  /** Per-file persona status for one orchestrator: does it override the
   *  shared file or inherit it? Main always reads shared. */
  const personaStatusFor = (orchKey: string) =>
    ORCH_PERSONA_FILES.map((file) => {
      if (orchKey !== "main") {
        const custom = orchFilePath(orchKey, file);
        if (existsSync(custom)) {
          const st = statSync(custom);
          return { file, source: "custom" as const, size: st.size, mtimeMs: st.mtimeMs };
        }
      }
      const shared = resolve(personaDir, file);
      if (existsSync(shared)) {
        const st = statSync(shared);
        return { file, source: "shared" as const, size: st.size, mtimeMs: st.mtimeMs };
      }
      return { file, source: "missing" as const, size: 0, mtimeMs: 0 };
    });

  /** Validate :key/:file params for the orchestrator persona routes.
   *  Returns null (with the right error response data) when invalid. */
  const orchPersonaTarget = (
    key: string,
    file: string,
  ): { error: string; status: 400 | 404 } | { customPath: string; sharedPath: string } => {
    if (!ORCH_KEY_RE.test(key) || RESERVED_ORCH_KEYS.has(key)) {
      return { error: "invalid orchestrator key", status: 400 };
    }
    if (!(ORCH_PERSONA_FILES as readonly string[]).includes(file)) {
      return { error: `file must be one of: ${ORCH_PERSONA_FILES.join(", ")}`, status: 400 };
    }
    return { customPath: orchFilePath(key, file), sharedPath: resolve(personaDir, file) };
  };

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
        // Trading inherits the operator's model when unset.
        effectiveModel: model || (key === "trading" ? operatorModel : model),
        inheritsOperator: key === "trading" && !model,
      };
    });

    // Named orchestrators: built-in main first, then [[orchestrators]]
    // entries. Exactly one is primary — an entry with role="primary" if
    // one exists, otherwise main.
    const entries = readOrchEntries(raw as Record<string, unknown>);
    const hasConfiguredPrimary = entries.some((e) => e.role === "primary");
    const mainNames = identityNames(raw as Record<string, unknown>);
    const orchestrators = [
      {
        key: "main",
        name: mainNames[0] ? mainNames[0][0]!.toUpperCase() + mainNames[0].slice(1) : "Main",
        invocations: mainNames,
        role: hasConfiguredPrimary ? ("secondary" as const) : ("primary" as const),
        builtin: true,
        model: operatorModel,
        effectiveModel: operatorModel,
        inheritsOperator: false,
        persona: personaStatusFor("main"),
      },
      ...entries.map((e) => ({
        key: e.key,
        name: e.name || e.key,
        invocations: e.invocations,
        role: e.role,
        builtin: false,
        model: e.model,
        effectiveModel: e.model || operatorModel,
        inheritsOperator: !e.model,
        persona: personaStatusFor(e.key),
      })),
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

  // ── Named-orchestrator CRUD ──

  // POST /orchestrators — create. Rejects key/invocation collisions (409).
  app.post("/orchestrators", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      key?: string;
      name?: string;
      invocations?: string[];
      role?: string;
      model?: string;
      /** Per-file persona choice; files not listed inherit the shared one.
       *  IDENTITY.md defaults to a custom scaffold (an orchestrator that
       *  inherits the shared identity would claim to BE the main persona). */
      persona?: Record<string, { mode?: string; content?: string }>;
    } | null;
    if (!body) return c.json({ error: "invalid JSON body" }, 400);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name required" }, 400);
    const key =
      typeof body.key === "string" && body.key.trim()
        ? body.key.trim().toLowerCase()
        : slugifyKey(name);
    if (!ORCH_KEY_RE.test(key)) {
      return c.json({ error: "key must be a lowercase slug (a-z, 0-9, -, _), max 32 chars" }, 400);
    }
    if (RESERVED_ORCH_KEYS.has(key)) return c.json({ error: `key "${key}" is reserved` }, 400);

    const raw = readConfigRaw();
    const entries = readOrchEntries(raw);
    if (entries.some((e) => e.key === key)) {
      return c.json({ error: `an orchestrator with key "${key}" already exists` }, 409);
    }

    const invocations = normInvocations(
      body.invocations && body.invocations.length > 0 ? body.invocations : [name],
    );
    if (invocations.length === 0) {
      return c.json({ error: "at least one invocation name required" }, 400);
    }
    const conflicts = invocationConflicts(invocations, raw, null);
    if (conflicts.length > 0) {
      return c.json(
        {
          error: `invocation${conflicts.length > 1 ? "s" : ""} already in use: ${conflicts
            .map((x) => `"${x.invocation}" (taken by ${x.ownerName})`)
            .join(", ")}`,
          conflicts,
        },
        409,
      );
    }

    const role = body.role === "primary" ? ("primary" as const) : ("secondary" as const);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (model.includes("/")) {
      return c.json({ error: "conversation models must be Claude Code models" }, 400);
    }

    // Exactly one primary: claiming it demotes the current holder.
    const nextEntries: OrchEntry[] = entries.map((e) =>
      role === "primary" && e.role === "primary" ? { ...e, role: "secondary" as const } : e,
    );
    nextEntries.push({ key, name, invocations, role, model });

    const merged: Record<string, unknown> = { ...raw, orchestrators: nextEntries };

    try {
      const { backupPath } = await writeConfig(merged);
      invalidateConfig();

      // Persona scaffolding after the config write — a scaffold failure
      // leaves a valid config (files fall back to shared per-file).
      const personaChoices = body.persona ?? {};
      mkdirSync(dirname(orchFilePath(key, "IDENTITY.md")), { recursive: true });
      const scaffolded: string[] = [];
      for (const file of ORCH_PERSONA_FILES) {
        const choice = personaChoices[file];
        const wantCustom =
          choice?.mode === "custom" || (file === "IDENTITY.md" && choice?.mode !== "shared");
        if (!wantCustom) continue;
        let content =
          typeof choice?.content === "string" && choice.content.trim() ? choice.content : null;
        if (content && content.length > 512 * 1024) {
          return c.json({ error: `${file} content too large` }, 400);
        }
        if (!content) {
          // Seed from the shared file so the user edits a real starting
          // point; IDENTITY gets the orchestrator-specific scaffold.
          const sharedPath = resolve(personaDir, file);
          content =
            file === "IDENTITY.md"
              ? scaffoldIdentity(name, invocations)
              : existsSync(sharedPath)
                ? readFileSync(sharedPath, "utf8")
                : `# ${file.replace(/\.md$/, "")}\n\n(custom for ${name})\n`;
        }
        writeFileSync(orchFilePath(key, file), content, "utf8");
        scaffolded.push(file);
      }

      return c.json({
        ok: true,
        key,
        scaffolded,
        requiresRestart: true,
        backup: backupPath,
        persona: personaStatusFor(key),
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // PUT /orchestrators/:key — edit name/invocations/role/model.
  // `main` accepts invocations (→ [identity].names) and model
  // (→ claude.model); its role is derived, not stored.
  app.put("/orchestrators/:key", async (c) => {
    const key = c.req.param("key");
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      invocations?: string[];
      role?: string;
      model?: string;
    } | null;
    if (!body) return c.json({ error: "invalid JSON body" }, 400);

    const raw = readConfigRaw();
    const merged: Record<string, unknown> = { ...raw };
    if (body.model?.includes("/")) {
      return c.json({ error: "conversation models must be Claude Code models" }, 400);
    }

    if (key === "main") {
      if (body.role === "primary") {
        // Promoting main = demoting every configured primary.
        merged.orchestrators = readOrchEntries(raw).map((e) =>
          e.role === "primary" ? { ...e, role: "secondary" as const } : e,
        );
      }
      if (body.invocations !== undefined) {
        const invocations = normInvocations(body.invocations);
        if (invocations.length === 0) {
          return c.json({ error: "at least one invocation name required" }, 400);
        }
        const conflicts = invocationConflicts(invocations, raw, "main");
        if (conflicts.length > 0) {
          return c.json(
            {
              error: `invocation${conflicts.length > 1 ? "s" : ""} already in use: ${conflicts
                .map((x) => `"${x.invocation}" (taken by ${x.ownerName})`)
                .join(", ")}`,
              conflicts,
            },
            409,
          );
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
    } else {
      if (!ORCH_KEY_RE.test(key)) return c.json({ error: "invalid orchestrator key" }, 400);
      const entries = readOrchEntries(raw);
      const idx = entries.findIndex((e) => e.key === key);
      if (idx === -1) return c.json({ error: `no orchestrator "${key}"` }, 404);

      const entry = { ...entries[idx]! };
      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) return c.json({ error: "name cannot be empty" }, 400);
        entry.name = name;
      }
      if (body.invocations !== undefined) {
        const invocations = normInvocations(body.invocations);
        if (invocations.length === 0) {
          return c.json({ error: "at least one invocation name required" }, 400);
        }
        const conflicts = invocationConflicts(invocations, raw, key);
        if (conflicts.length > 0) {
          return c.json(
            {
              error: `invocation${conflicts.length > 1 ? "s" : ""} already in use: ${conflicts
                .map((x) => `"${x.invocation}" (taken by ${x.ownerName})`)
                .join(", ")}`,
              conflicts,
            },
            409,
          );
        }
        entry.invocations = invocations;
      }
      if (body.role !== undefined) {
        entry.role = body.role === "primary" ? "primary" : "secondary";
      }
      if (body.model !== undefined) entry.model = body.model.trim();

      merged.orchestrators = entries.map((e, i) =>
        i === idx
          ? entry
          : entry.role === "primary" && e.role === "primary"
            ? { ...e, role: "secondary" as const }
            : e,
      );
    }

    try {
      const { backupPath } = await writeConfig(merged);
      invalidateConfig();
      return c.json({ ok: true, requiresRestart: true, backup: backupPath });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // DELETE /orchestrators/:key — remove the config entry.
  // The persona dir is left on disk (non-destructive; recreating the key
  // picks it back up) and any orch:<key> sessions go inert.
  app.delete("/orchestrators/:key", async (c) => {
    const key = c.req.param("key");
    if (key === "main") return c.json({ error: "the main persona cannot be deleted" }, 400);
    if (!ORCH_KEY_RE.test(key)) return c.json({ error: "invalid orchestrator key" }, 400);

    const raw = readConfigRaw();
    const entries = readOrchEntries(raw);
    if (!entries.some((e) => e.key === key)) {
      return c.json({ error: `no orchestrator "${key}"` }, 404);
    }

    const merged: Record<string, unknown> = {
      ...raw,
      orchestrators: entries.filter((e) => e.key !== key),
    };

    try {
      const { backupPath } = await writeConfig(merged);
      invalidateConfig();
      return c.json({
        ok: true,
        requiresRestart: true,
        backup: backupPath,
        personaDirKept: existsSync(dirname(orchFilePath(key, "IDENTITY.md"))),
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // GET /orchestrators/:key/persona/:file — effective content + source.
  app.get("/orchestrators/:key/persona/:file", (c) => {
    const target = orchPersonaTarget(c.req.param("key"), c.req.param("file"));
    if ("error" in target) return c.json({ error: target.error }, target.status);
    const hasCustom = existsSync(target.customPath);
    const hasShared = existsSync(target.sharedPath);
    if (!hasCustom && !hasShared) return c.json({ error: "not found" }, 404);
    return c.json({
      file: c.req.param("file"),
      source: hasCustom ? "custom" : "shared",
      content: readFileSync(hasCustom ? target.customPath : target.sharedPath, "utf8"),
      sharedContent: hasShared ? readFileSync(target.sharedPath, "utf8") : null,
    });
  });

  // PUT /orchestrators/:key/persona/:file { content } — write the custom
  // override (creating it if the file currently inherits the shared one).
  app.put("/orchestrators/:key/persona/:file", async (c) => {
    const key = c.req.param("key");
    const file = c.req.param("file");
    const target = orchPersonaTarget(key, file);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
    if (typeof body?.content !== "string") return c.json({ error: "content required" }, 400);
    if (body.content.length > 512 * 1024) return c.json({ error: "content too large" }, 400);

    try {
      const backup = backupFile(target.customPath, `orch-${key}-${file}`);
      mkdirSync(dirname(target.customPath), { recursive: true });
      writeFileSync(target.customPath, body.content, "utf8");
      return c.json({ ok: true, source: "custom", backup });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // DELETE /orchestrators/:key/persona/:file — drop the custom override,
  // reverting the file to the shared one (backed up first).
  app.delete("/orchestrators/:key/persona/:file", (c) => {
    const key = c.req.param("key");
    const file = c.req.param("file");
    const target = orchPersonaTarget(key, file);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    if (!existsSync(target.customPath)) {
      return c.json({ error: "no custom override to revert" }, 404);
    }
    try {
      const backup = backupFile(target.customPath, `orch-${key}-${file}`);
      unlinkSync(target.customPath);
      return c.json({ ok: true, source: "shared", backup });
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
