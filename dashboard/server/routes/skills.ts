import { resolve } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import {
  type InstallOptions,
  approveSkill,
  readDb,
  setDisabled,
  uninstallSkill,
} from "../../../src/skills/installer.ts";
import type { SkillDto } from "../types.ts";

/**
 * Marketplace inspector: list installed skills, approve scripts, disable,
 * uninstall. Install-from-source is intentionally kept CLI-only — it
 * requires network fetches + vetting that doesn't belong on a dashboard
 * button.
 */
export function skillsRoutes(deps: { config: Config; repoRoot: string }): Hono {
  const app = new Hono();
  const skillsRoot = resolve(deps.repoRoot, "skills");
  const dbPath = resolve(deps.config.paths.data_dir, deps.config.skills_marketplace.installed_db);
  const opts: InstallOptions = {
    skillsRoot,
    dbPath,
    requireApprovalForScripts: deps.config.skills_marketplace.require_approval_for_scripts,
  };

  app.get("/", (c) => {
    const db = readDb(dbPath);
    const skills: SkillDto[] = Object.values(db.skills).map((s) => ({
      name: s.name,
      source: s.source,
      version: s.version,
      sha: s.sha,
      installedAt: s.installed_at,
      needsApproval: s.needs_approval,
      approvedAt: s.approved_at,
      hasScripts: s.has_scripts,
      disabled: s.disabled,
    }));
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({
      skills,
      config: {
        enabled: deps.config.skills_marketplace.enabled,
        allowedSources: deps.config.skills_marketplace.allowed_sources,
        requireApprovalForScripts: deps.config.skills_marketplace.require_approval_for_scripts,
        installedDbPath: dbPath,
        skillsRoot,
      },
    });
  });

  app.post("/:name/approve", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const res = approveSkill(name, dbPath);
    return c.json(res, res.ok ? 200 : 400);
  });

  app.post("/:name/disable", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const body = (await c.req.json().catch(() => ({}))) as { disabled?: boolean };
    const res = setDisabled(name, body.disabled ?? true, dbPath);
    return c.json(res, res.ok ? 200 : 400);
  });

  app.delete("/:name", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const res = uninstallSkill(name, opts);
    return c.json(res, res.uninstalled ? 200 : 400);
  });

  return app;
}
