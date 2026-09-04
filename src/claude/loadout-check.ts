import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexCompatibilityWarning } from "../codex/executable.ts";
import { backendForModel } from "../model/backend.ts";
import { findBin } from "./mcp-config.ts";
import { PERSONA_DIR } from "./persona.ts";

/**
 * Startup self-check: verify the persona/* and skills/* directories the
 * daemon expects to inject into Claude are actually readable. Called once
 * from main.ts at boot so missing files show up in data/daemon.log before
 * the first iMessage turn runs — otherwise the failure is silent (the
 * prompt gets assembled with empty sections and Edmund just behaves oddly).
 *
 * Intentionally does NOT mutate anything. Pure diagnostic.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

type PersonaReport = {
  dir: string;
  files: Array<{ name: string; ok: boolean; bytes: number }>;
  personCount: number;
};

type SkillsReport = {
  dir: string;
  total: number;
  missing: string[];
  names: string[];
};

export type LoadoutReport = {
  persona: PersonaReport;
  skills: SkillsReport;
  warnings: string[];
};

export function checkLoadout(model?: string): LoadoutReport {
  const warnings: string[] = [];

  if (model) {
    const backend = backendForModel(model);
    if (backend === "codex") {
      const warning = codexCompatibilityWarning();
      if (warning) warnings.push(`${warning} for configured model ${JSON.stringify(model)}`);
    } else if (!findBin("claude")) {
      warnings.push(`claude CLI not found for configured model ${JSON.stringify(model)}`);
    }
  }

  const personaFiles = ["IDENTITY.md", "SOUL.md", "AGENTS.md"].map((name) => {
    const p = join(PERSONA_DIR, name);
    const ok = existsSync(p);
    const bytes = ok ? statSync(p).size : 0;
    if (!ok) warnings.push(`persona file missing: ${p}`);
    else if (bytes === 0) warnings.push(`persona file empty: ${p}`);
    return { name, ok, bytes };
  });
  const peopleDir = join(PERSONA_DIR, "people");
  const personCount = existsSync(peopleDir)
    ? readdirSync(peopleDir).filter((f) => f.endsWith(".md")).length
    : 0;

  const skillsNames: string[] = [];
  const missing: string[] = [];
  if (!existsSync(SKILLS_ROOT)) {
    warnings.push(`skills dir missing: ${SKILLS_ROOT}`);
  } else {
    for (const name of readdirSync(SKILLS_ROOT).sort()) {
      if (name.startsWith(".")) continue; // .trash, .DS_Store & friends
      const dir = join(SKILLS_ROOT, name);
      if (!statSync(dir).isDirectory()) continue;
      const manifest = join(dir, "SKILL.md");
      if (existsSync(manifest)) skillsNames.push(name);
      else missing.push(name);
    }
    if (skillsNames.length === 0) warnings.push(`skills dir has no SKILL.md files: ${SKILLS_ROOT}`);
    if (missing.length > 0) {
      warnings.push(`skills without SKILL.md (invisible to list_skills): ${missing.join(", ")}`);
    }
  }

  // MCP tool-schema deferral: Claude Code defers MCP schemas behind
  // ToolSearch by default, which keeps ~125 tools' worth of definitions
  // (~40k+ tokens measured for the full loadout) out of every context
  // window. Workers inherit the daemon's env (see directClaudeEnv), so
  // either of these variables leaking in from a shell or the LaunchAgent
  // plist silently re-inflates every session. Warn loudly at boot.
  if (process.env.ENABLE_TOOL_SEARCH === "false") {
    warnings.push(
      "ENABLE_TOOL_SEARCH=false is set — MCP tool schemas load eagerly, adding ~40k+ tokens to every worker context. Unset it unless deliberate.",
    );
  }
  if (process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
    warnings.push(
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set — this disables MCP tool-schema deferral (tool search), adding ~40k+ tokens to every worker context.",
    );
  }

  return {
    persona: { dir: PERSONA_DIR, files: personaFiles, personCount },
    skills: { dir: SKILLS_ROOT, total: skillsNames.length, missing, names: skillsNames },
    warnings,
  };
}

export function formatLoadoutReport(r: LoadoutReport): string {
  // Single-line summary on the happy path. Previously emitted one line per
  // persona file + per skill list = 8+ lines on every boot. Now: one line
  // with counts and an "ok" tag; only break out detail when something is
  // missing or warnings fire (those NEED to be visible).
  const personaOk = r.persona.files.filter((f) => f.ok).length;
  const personaTotal = r.persona.files.length;
  const missingPersona = r.persona.files.filter((f) => !f.ok).map((f) => f.name);
  const summary =
    `[loadout] persona=${personaOk}/${personaTotal} people=${r.persona.personCount} ` +
    `skills=${r.skills.total}${r.skills.missing.length > 0 ? `(${r.skills.missing.length} missing SKILL.md)` : ""}`;
  const lines: string[] = [summary];
  // Anomalies — only logged when they actually exist.
  if (missingPersona.length > 0) {
    lines.push(`[loadout] ✗ missing persona files: ${missingPersona.join(", ")}`);
  }
  // Whole directory absent is the fresh-clone case: persona/ is gitignored, so
  // a new checkout has none. The harness still runs — it just has no identity,
  // no venue rules, and no memory, which is invisible unless we say it here.
  if (personaOk === 0) {
    lines.push(
      "[loadout] ✗ NO PERSONA LOADED — the assistant has no identity, venue rules, or memory.",
    );
    lines.push("[loadout]   fix: cp -r persona.example persona   (then edit persona/IDENTITY.md)");
  }
  if (r.skills.missing.length > 0) {
    lines.push(`[loadout] ✗ skills without SKILL.md: ${r.skills.missing.join(", ")}`);
  }
  for (const w of r.warnings) lines.push(`[loadout] WARN ${w}`);
  return lines.join("\n");
}
