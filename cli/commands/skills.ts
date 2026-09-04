/**
 * `edmund skills list`                       — show installed marketplace skills
 * `edmund skills search [query]`             — search the curated registry
 * `edmund skills install <name> <source>`    — install from a marketplace source
 * `edmund skills uninstall <name>`           — remove an installed skill
 * `edmund skills approve <name>`             — operator-approve a scripts-bearing skill
 * `edmund skills disable <name>`             — hide a skill from the model
 * `edmund skills enable <name>`              — re-enable a previously disabled skill
 * `edmund skills curated`                    — what the curator wrote, why, and whether it is used
 * `edmund skills curate-now`                 — force a curator + lifecycle pass
 * `edmund skills consent`                    — who has agreed to which published skill
 */

import { resolve } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { AddressBook } from "../../src/sessions/address-book.ts";
import { ContactBook } from "../../src/sessions/contacts.ts";
import { readConsentDb } from "../../src/skills/consent.ts";
import { SkillCurator } from "../../src/skills/curator-observer.ts";
import {
  approveSkill,
  installSkill,
  readDb,
  setDisabled,
  uninstallSkill,
} from "../../src/skills/installer.ts";
import { categoryOf } from "../../src/skills/installer.ts";
import { fetchSkillFiles, loadManifest, searchMarketplace } from "../../src/skills/registry.ts";
import { readUsageEvents, summarizeUsage } from "../../src/skills/usage.ts";
import type { Parsed } from "../args.ts";
import { REPO } from "../services/paths.ts";
import { color, fail, info, ok, print, section, table } from "../ui.ts";

const SKILLS_USAGE = `${color.bold("edmund skills")} — manage marketplace skills

${color.bold("Usage:")}
  edmund skills list
  edmund skills search [query]
  edmund skills install <name> <source>
  edmund skills uninstall <name>
  edmund skills approve <name>
  edmund skills disable <name>
  edmund skills enable <name>
  edmund skills curated
  edmund skills curate-now
  edmund skills consent
`;

function opts() {
  const cfg = loadConfig();
  const dbPath = resolve(cfg.paths.data_dir, cfg.skills_marketplace.installed_db);
  const skillsRoot = resolve(REPO, "skills");
  return {
    cfg,
    dbPath,
    install: {
      skillsRoot,
      dbPath,
      requireApprovalForScripts: cfg.skills_marketplace.require_approval_for_scripts,
    },
    fetch: {
      allowedSources: cfg.skills_marketplace.allowed_sources,
      timeoutMs: cfg.skills_marketplace.fetch_timeout_seconds * 1000,
    },
  };
}

export async function skillsCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    print(SKILLS_USAGE);
    return;
  }

  switch (sub) {
    case "list":
    case "ls":
      return listInstalled();
    case "search":
      return search(p.positional[1]);
    case "install":
      return install(p.positional[1], p.positional[2]);
    case "uninstall":
    case "remove":
    case "rm":
      return uninstall(p.positional[1]);
    case "approve":
      return approve(p.positional[1]);
    case "disable":
      return setDisable(p.positional[1], true);
    case "enable":
      return setDisable(p.positional[1], false);
    case "curated":
      return listCurated();
    case "curate-now":
      return curateNow();
    case "consent":
      return listConsent();
    default:
      fail(`unknown skills subcommand: ${sub}`);
      print(SKILLS_USAGE);
      process.exit(2);
  }
}

function listInstalled(): void {
  const { dbPath } = opts();
  const db = readDb(dbPath);
  const names = Object.keys(db.skills).sort();
  section("installed marketplace skills");
  if (names.length === 0) {
    info("none.");
    return;
  }
  const rows = names.map((n) => {
    const r = db.skills[n]!;
    const status = r.disabled
      ? color.red("disabled")
      : r.needs_approval
        ? color.yellow("needs-approval")
        : color.green("ok");
    return [
      n,
      `${r.source}${r.version ? `@${r.version}` : ""}`,
      status,
      r.has_scripts ? "scripts" : "",
      r.sha.slice(0, 10),
    ];
  });
  table(["name", "source", "status", "type", "sha"], rows);
}

async function search(query: string | undefined): Promise<void> {
  const o = opts();
  section(`marketplace${query ? ` · ${query}` : ""}`);
  try {
    const hits = await searchMarketplace(query, o.fetch);
    if (hits.length === 0) {
      info("no matches.");
      return;
    }
    table(
      ["name", "source", "version", "description"],
      hits.map((h) => [
        h.name,
        h.source,
        h.version ?? "",
        h.description.length > 70 ? `${h.description.slice(0, 67)}…` : h.description,
      ]),
    );
  } catch (e) {
    fail(`search failed: ${(e as Error).message}`);
  }
}

async function install(name: string | undefined, source: string | undefined): Promise<void> {
  if (!name || !source) {
    fail("usage: edmund skills install <name> <source>");
    process.exit(2);
  }
  const o = opts();
  try {
    const manifest = await loadManifest(source, o.fetch);
    const entry = manifest.skills.find((s) => s.name === name);
    if (!entry) {
      fail(`skill "${name}" not in source ${source}`);
      process.exit(1);
    }
    info(`fetching ${entry.path} from ${source}…`);
    const files = await fetchSkillFiles(source, entry.path, o.fetch);
    const result = installSkill({
      name: entry.name,
      source,
      version: entry.version ?? null,
      files,
      opts: o.install,
    });
    if (!result.installed) {
      fail(`install rejected: ${result.reason}`);
      process.exit(1);
    }
    ok(`installed ${name} (sha ${result.record.sha.slice(0, 12)})`);
    if (result.record.needs_approval) {
      print(
        color.yellow(
          `  ⚠ skill ships executable scripts. run 'edmund skills approve ${name}' before any are executed.`,
        ),
      );
    }
  } catch (e) {
    fail((e as Error).message);
    process.exit(1);
  }
}

function uninstall(name: string | undefined): void {
  if (!name) {
    fail("usage: edmund skills uninstall <name>");
    process.exit(2);
  }
  const o = opts();
  const result = uninstallSkill(name, o.install);
  if (!result.uninstalled) {
    fail(result.reason);
    process.exit(1);
  }
  ok(`uninstalled ${name} (moved to skills/.trash/)`);
}

function approve(name: string | undefined): void {
  if (!name) {
    fail("usage: edmund skills approve <name>");
    process.exit(2);
  }
  const o = opts();
  const result = approveSkill(name, o.dbPath);
  if (!result.ok) {
    fail(result.reason);
    process.exit(1);
  }
  ok(`approved ${name} — model may now execute its scripts.`);
}

function setDisable(name: string | undefined, disabled: boolean): void {
  if (!name) {
    fail(`usage: edmund skills ${disabled ? "disable" : "enable"} <name>`);
    process.exit(2);
  }
  const o = opts();
  const result = setDisabled(name, disabled, o.dbPath);
  if (!result.ok) {
    fail(result.reason);
    process.exit(1);
  }
  ok(`${disabled ? "disabled" : "enabled"} ${name}`);
}

/**
 * The curator's output, with its evidence and its usage side by side.
 *
 * These skills were written by a model, from other people's conversations,
 * and are readable in every chat. That combination is exactly the thing an
 * operator should be able to audit without reading a log — what was written,
 * on what evidence, and whether anyone has actually reached for it.
 */
function listCurated(): void {
  const { dbPath, cfg } = opts();
  const db = readDb(dbPath);
  const usage = summarizeUsage(readUsageEvents(cfg.paths.data_dir));

  const curated = Object.values(db.skills).filter((r) => categoryOf(r) === "curated");
  section("curated skills");
  if (curated.length === 0) {
    info("none — the curator has not found a pattern that cleared the bar.");
  } else {
    table(
      ["name", "written", "reads", "chats", "evidence"],
      curated.map((r) => {
        const u = usage.get(r.name);
        return [
          r.name,
          new Date(r.installed_at).toISOString().slice(0, 10),
          String(u?.reads ?? 0),
          String(u?.sessions.size ?? 0),
          String(r.provenance?.length ?? 0),
        ];
      }),
    );
    for (const r of curated) {
      if (!r.provenance?.length) continue;
      section(`${r.name} — why it was written`);
      for (const line of r.provenance) print(`  ${line}`);
    }
  }

  const retired = Object.values(db.retired ?? {});
  if (retired.length > 0) {
    section("retired");
    table(
      ["name", "retired", "reads", "reason"],
      retired.map((r) => [
        r.name,
        new Date(r.retired_at).toISOString().slice(0, 10),
        String(r.reads),
        r.reason,
      ]),
    );
  }
}

/** Force a pass now, instead of waiting for the daily tick. */
async function curateNow(): Promise<void> {
  const { cfg, dbPath, install } = opts();
  const contacts = new ContactBook(cfg.contacts, new AddressBook());
  const curator = new SkillCurator({
    config: cfg,
    dataDir: cfg.paths.data_dir,
    skillsRoot: install.skillsRoot,
    dbPath,
    consentDbPath: resolve(cfg.paths.data_dir, cfg.public_skills.consent_db),
    contacts,
  });
  section("curator pass");
  const { curated, lifecycle } = await curator.runNow();

  for (const r of lifecycle?.retired ?? []) info(`retired ${r.name} — ${r.reason}`);
  for (const r of lifecycle?.reviewed ?? []) info(`reviewed ${r.name} → ${r.verdict}: ${r.reason}`);

  if (!curated.ran) {
    info(`no pass: ${curated.reason}`);
    return;
  }
  if (curated.created) {
    ok(`wrote ${curated.created} (from ${curated.considered} asks)`);
  } else {
    info(`nothing cleared the bar (considered ${curated.considered} asks)`);
  }
  for (const r of curated.rejected) info(`rejected — ${r}`);
}

/** Who has been asked about a published skill, and what they said. */
function listConsent(): void {
  const { cfg, dbPath } = opts();
  const db = readDb(dbPath);
  const consent = readConsentDb(resolve(cfg.paths.data_dir, cfg.public_skills.consent_db));

  const published = Object.values(db.skills).filter((r) => categoryOf(r) === "public");
  section("published skills");
  if (published.length === 0) {
    info("none.");
  } else {
    table(
      ["name", "published by", "when"],
      published.map((r) => [
        r.name,
        r.publisher_name ?? r.publisher ?? "?",
        r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : "",
      ]),
    );
  }

  const decisions = Object.entries(consent.decisions);
  section("decisions");
  if (decisions.length === 0) {
    info("nobody has been asked yet.");
    return;
  }
  table(
    ["skill", "chat", "answer", "when"],
    decisions.map(([k, v]) => [
      k.split("|")[0] ?? k,
      v.session_key,
      v.decision === "allow" ? color.green("allow") : color.red("deny"),
      new Date(v.at_ms).toISOString().slice(0, 10),
    ]),
  );
}
