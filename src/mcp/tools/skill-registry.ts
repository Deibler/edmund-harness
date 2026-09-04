/**
 * MCP tools for the skill marketplace. Lets the model search the
 * curated registry, install a skill, list what's installed, and
 * uninstall. Installs that ship executable content are flagged
 * `needs_approval`; the model is taught to refuse to run them until
 * an operator approves via `edmund skills approve <name>`.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type InstallOptions,
  installSkill,
  readDb,
  uninstallSkill,
} from "../../skills/installer.ts";
import {
  type FetchOptions,
  fetchSkillFiles,
  loadManifest,
  searchMarketplace,
} from "../../skills/registry.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function fetchOpts(ctx: ToolContext): FetchOptions {
  const cfg = ctx.config.skills_marketplace;
  return {
    allowedSources: cfg.allowed_sources,
    timeoutMs: cfg.fetch_timeout_seconds * 1000,
  };
}

function installOpts(ctx: ToolContext): InstallOptions {
  const cfg = ctx.config.skills_marketplace;
  return {
    skillsRoot: resolve(SKILLS_ROOT),
    dbPath: resolve(ctx.dataDir, cfg.installed_db),
    requireApprovalForScripts: cfg.require_approval_for_scripts,
  };
}

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

const SearchInput = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Keyword filter (matches name + description). Omit to list everything across allowed sources.",
    ),
});

const InstallInput = z.object({
  name: z.string().describe("Skill name as listed in the marketplace (e.g. 'pdf-extract')."),
  source: z
    .string()
    .describe(
      "Source slug as listed in the marketplace (e.g. 'anthropics/skills'). Must be on the operator allowlist.",
    ),
});

const UninstallInput = z.object({
  name: z.string().describe("Name of the installed skill to remove."),
});

const NoInput = z.object({});

export function skillRegistryTools(ctx: ToolContext): ToolDef[] {
  if (!ctx.config.skills_marketplace.enabled) return [];

  return [
    {
      name: "search_marketplace",
      description:
        "Search the curated skill marketplace for skills you might want to install. Returns name, source, version, and one-line description for each match. Skills are *not* loaded into your context until you also `install_skill` AND then `read_skill` — keep this step cheap. Allowlist is operator-controlled.",
      inputSchema: SearchInput,
      handler: async (args) => {
        try {
          const hits = await searchMarketplace(args.query, fetchOpts(ctx));
          if (hits.length === 0) {
            return text(
              args.query
                ? `no marketplace skills match "${args.query}"`
                : "no skills found in any allowed source",
            );
          }
          const body = hits
            .map(
              (h) =>
                `• ${h.name} (${h.source}${h.version ? ` @ ${h.version}` : ""}) — ${h.description}`,
            )
            .join("\n");
          return text(body);
        } catch (e) {
          return text(`marketplace search failed: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "install_skill",
      description:
        "Install a skill from the marketplace into the local skills/ dir. After install you can call `read_skill(name)` to load its instructions. If the skill ships executable scripts, it will be marked `needs_approval` and you MUST NOT execute its scripts until the operator approves via `edmund skills approve <name>` — surface the approval ask to the user.",
      inputSchema: InstallInput,
      handler: async (args) => {
        try {
          const manifest = await loadManifest(args.source, fetchOpts(ctx));
          const entry = manifest.skills.find((s) => s.name === args.name);
          if (!entry) {
            return text(`skill "${args.name}" not found in source ${args.source}`, true);
          }
          const files = await fetchSkillFiles(args.source, entry.path, fetchOpts(ctx));
          const result = installSkill({
            name: entry.name,
            source: args.source,
            version: entry.version ?? null,
            files,
            opts: installOpts(ctx),
          });
          if (!result.installed) {
            return text(`install rejected: ${result.reason}`, true);
          }
          const note = result.record.needs_approval
            ? ` ⚠ contains executable scripts — operator must run \`edmund skills approve ${entry.name}\` before any script in it is run.`
            : "";
          return text(
            `installed ${entry.name} from ${args.source} (sha ${result.record.sha.slice(0, 12)}).${note}`,
          );
        } catch (e) {
          return text(`install failed: ${(e as Error).message}`, true);
        }
      },
    },
    {
      name: "uninstall_skill",
      description:
        "Remove an installed skill from the local skills/ dir. The skill is moved to skills/.trash/ (not permanently deleted) so an operator can recover it if needed.",
      inputSchema: UninstallInput,
      handler: (args) => {
        const result = uninstallSkill(args.name, installOpts(ctx));
        if (!result.uninstalled) {
          return text(`uninstall failed: ${result.reason}`, true);
        }
        return text(`uninstalled ${args.name}`);
      },
    },
    {
      name: "list_installed_skills",
      description:
        "List every skill installed from the marketplace with its source, version, approval status, and install date. Pre-shipped skills (those that were already in skills/ before any marketplace install) won't appear here — use `list_skills` for the full discovery view.",
      inputSchema: NoInput,
      handler: () => {
        const db = readDb(installOpts(ctx).dbPath);
        const names = Object.keys(db.skills);
        if (names.length === 0) return text("no marketplace skills installed");
        const lines = names.sort().map((n) => {
          const r = db.skills[n]!;
          const flags = [
            r.disabled ? "DISABLED" : null,
            r.needs_approval ? "needs-approval" : null,
            r.has_scripts ? "scripts" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return `• ${n} ← ${r.source}${r.version ? ` @ ${r.version}` : ""}${flags ? ` [${flags}]` : ""}`;
        });
        return text(lines.join("\n"));
      },
    },
  ];
}
