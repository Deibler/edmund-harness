/**
 * What this conversation can actually ask Edmund to do — the browsable
 * catalogue behind the portal's Skills tab.
 *
 * This is the public face of the skills subsystem, and "public" is doing real
 * work in that sentence: the page is reachable by anyone holding one person's
 * standing portal link, so it must show what THEY can use and nothing else.
 * Three exclusions, all of them load-bearing:
 *
 *   • a skill scoped to a different conversation does not appear, and is not
 *     hinted at. Another chat having a private skill is that chat's business.
 *   • a skill owned by an integration that is switched off does not appear —
 *     the same rule list_skills applies, so the page cannot promise something
 *     the model would refuse.
 *   • a published skill shows WHOSE it is, and whether this conversation has
 *     agreed to it, because that agreement is the thing the person is being
 *     asked for in the chat.
 *
 * Descriptions come from each SKILL.md's frontmatter — the same line the
 * model reads — so the page cannot drift from what Edmund actually sees.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import { unavailableIntegrationSkills } from "../../../src/integrations/host.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { SessionKey } from "../../../src/sessions/key.ts";
import { skillVisibleTo } from "../../../src/skills/author.ts";
import { consentState } from "../../../src/skills/consent.ts";
import { categoryOf, readDb } from "../../../src/skills/installer.ts";
import { type SkillGroup, skillGroupOf } from "../../../src/skills/provenance.ts";

export type { SkillGroup };

export type PortalSkill = {
  name: string;
  description: string;
  group: SkillGroup;
  /** "Built in" | "Curated" | "From <name>" | "Yours" */
  origin: string;
  /** Set for published skills this chat has not agreed to yet. */
  needsConsent: boolean;
  /** True when this conversation authored it. */
  mine: boolean;
};

export type PortalSkillsDeps = {
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  chatGuids: string[];
  repoRoot: string;
};

export function listPortalSkills(sessionKey: SessionKey, deps: PortalSkillsDeps): PortalSkill[] {
  const skillsRoot = resolve(deps.repoRoot, "skills");
  if (!existsSync(skillsRoot)) return [];

  const dbPath = resolve(deps.config.paths.data_dir, deps.config.skills_marketplace.installed_db);
  const db = readDb(dbPath);
  const consentDbPath = resolve(deps.config.paths.data_dir, deps.config.public_skills.consent_db);
  const hidden = unavailableIntegrationSkills(deps.config);

  const out: PortalSkill[] = [];
  for (const name of readdirSync(skillsRoot)) {
    if (name.startsWith(".")) continue;
    const dir = join(skillsRoot, name);
    let manifest: string;
    try {
      if (!statSync(dir).isDirectory()) continue;
      manifest = join(dir, "SKILL.md");
      if (!existsSync(manifest)) continue;
    } catch {
      continue;
    }

    const record = db.skills[name];
    if (record?.disabled) continue;
    if (!skillVisibleTo(record, sessionKey)) continue;
    if (hidden.has(name)) continue;

    const description = parseDescription(readFileSync(manifest, "utf8")) ?? "";
    const category = categoryOf(record);

    // One classifier, shared with the model's list_skills. A page that
    // grouped skills differently from the way the model is told about them
    // would be worse than no grouping.
    const group = skillGroupOf(record, sessionKey);
    const mine = group === "yours";
    let needsConsent = false;
    let origin = "Ships with Edmund";

    if (group === "curated") {
      origin = "Edmund worked this one out himself";
    } else if (group === "public") {
      origin = `Published by ${record?.publisher_name ?? record?.publisher ?? "someone"}`;
      const state = consentState(record, sessionKey, {
        chatDb: deps.chatDb,
        contacts: deps.contacts,
        chatGuids: deps.chatGuids,
        consentDbPath,
      });
      needsConsent = state.required;
    } else if (group === "yours") {
      origin =
        category === "public" ? "Yours — shared with everyone" : "Yours — private to this chat";
    }

    out.push({ name, description, group, origin, needsConsent, mine });
  }

  // Grouped order, then alphabetical inside each: what is theirs, then what
  // came from other people, then what Edmund taught himself, then the stock
  // catalogue. A person opening this page is looking for the first three.
  const rank: Record<SkillGroup, number> = { yours: 0, public: 1, curated: 2, system: 3 };
  return out.sort((a, b) => {
    if (a.group !== b.group) return rank[a.group] - rank[b.group];
    return a.name.localeCompare(b.name);
  });
}

function parseDescription(md: string): string | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm?.[1]) return null;
  const line = fm[1].split("\n").find((l) => l.trim().toLowerCase().startsWith("description:"));
  if (!line) return null;
  return line
    .replace(/^[^:]*:\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}
