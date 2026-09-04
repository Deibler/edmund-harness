import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { unavailableIntegrationSkills } from "../../integrations/host.ts";
import { StateStore } from "../../sessions/store.ts";
import { authorSkill, skillVisibleTo, updateAuthoredSkill } from "../../skills/author.ts";
import { type ConsentDeps, consentState, recordDecision, serveAsk } from "../../skills/consent.ts";
import { categoryOf, readDb } from "../../skills/installer.ts";
import {
  GROUP_BLURB,
  SKILL_GROUPS,
  type SkillGroup,
  skillGroupOf,
} from "../../skills/provenance.ts";
import { publishSkill, unpublishSkill } from "../../skills/publish.ts";
import { recordSkillRead } from "../../skills/usage.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Progressive skill discovery. Skills live in `./skills/<name>/SKILL.md` with
 * YAML frontmatter `name:` / `description:`. The model:
 *   1. calls `list_skills(query?)` → one-line descriptions
 *   2. calls `read_skill(name)` → full SKILL.md when it decides to use one
 *
 * This keeps the system prompt small (no per-skill briefing) while letting the
 * catalog grow without re-deploying.
 *
 * SKILLS_ROOT is anchored to this file's location, not process.cwd(). Claude
 * Code spawns the MCP server inheriting cwd=sandbox, so a cwd-relative lookup
 * resolves to `<sandbox>/skills` and finds nothing. Going up three levels from
 * `src/mcp/tools/` lands at the project root where `skills/` actually lives.
 */

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

const ListInput = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional keywords to filter by. Matches against name + description. Omit to list everything.",
    ),
  from: z
    .enum(["yours", "public", "curated", "system"])
    .optional()
    .describe(
      "Optional filter by WHERE the skill came from, which decides what you may do with it. 'yours' — written in this conversation; the only ones update_skill can edit or publish_skill can share. 'public' — another person published it; the first use here needs their agreement unless the author is in the chat. 'curated' — you wrote it yourself from a job recurring across unrelated conversations; no permission needed. 'system' — ships with Edmund. Omit to see everything, grouped.",
    ),
});

const ReadInput = z.object({
  name: z.string().describe("Skill directory name, e.g. 'instant-share'."),
});

const ExtraFile = z.object({
  path: z
    .string()
    .describe("Relative path inside the skill dir, e.g. 'template.md' or 'data/teams.json'."),
  content: z.string().describe("Full file content (text only)."),
});

const CreateInput = z.object({
  name: z
    .string()
    .describe(
      "Kebab-case skill name, e.g. 'class-report' or 'sky-sunday-image'. Becomes the dir name.",
    ),
  description: z
    .string()
    .describe(
      "One line for the list_skills catalog — what this skill does and when to reach for it.",
    ),
  instructions: z
    .string()
    .describe(
      "The SKILL.md body — the full playbook your future self follows: the steps, the tools to call, the format the user expects, the gotchas you learned. Write it like you'd want to find it cold.",
    ),
  extra_files: z
    .array(ExtraFile)
    .max(20)
    .optional()
    .describe("Optional supporting files: templates, reference data, scripts."),
  share: z
    .enum(["this_chat", "everyone"])
    .optional()
    .describe(
      "Visibility. Default 'this_chat': the skill exists only in this conversation — right for anything grown out of one person's asks. 'everyone' makes it available in all chats — ONLY for fully generic skills with zero personal context in them.",
    ),
});

const UpdateSkillInput = z.object({
  name: z.string().describe("Name of a self-authored skill to edit."),
  description: z.string().optional().describe("New catalog line. Omit to keep."),
  instructions: z.string().optional().describe("New full SKILL.md body. Omit to keep."),
  extra_files: z
    .array(ExtraFile)
    .max(20)
    .optional()
    .describe("Files to add or overwrite by path. Files not named here are kept as-is."),
});

const PublishInput = z.object({
  name: z.string().describe("Name of a skill you authored in this chat."),
});

const ConfirmInput = z.object({
  name: z.string().describe("The published skill they were asked about."),
  decision: z
    .enum(["allow", "deny"])
    .describe(
      "What they actually said. 'allow' unlocks the skill in this conversation from now on; 'deny' means solve it another way and don't raise it again.",
    ),
});

/**
 * The session's last inbound timestamp, as proof a person spoke.
 *
 * Opened on demand and closed immediately — the same pattern history.ts and
 * message.ts use. The consent path must not hold a handle on state.db for the
 * life of the MCP subprocess just to read one number.
 *
 * Returns null when there is no session row, and the consent check fails
 * closed on null: a conversation with no recorded inbound cannot have
 * answered a question.
 */
function lastInboundMs(dataDir: string, sessionKey: string): number | null {
  let store: StateStore | null = null;
  try {
    store = new StateStore(dataDir);
    return store.getSession(sessionKey)?.lastInboundMs ?? null;
  } catch {
    return null;
  } finally {
    store?.close?.();
  }
}

export function skillTools(ctx: ToolContext): ToolDef[] {
  const dbPath = resolve(ctx.dataDir, ctx.config.skills_marketplace.installed_db);
  const consentDbPath = resolve(ctx.dataDir, ctx.config.public_skills.consent_db);
  const consentDeps: ConsentDeps = {
    chatDb: ctx.chatDb,
    contacts: ctx.contacts,
    chatGuids: ctx.chatGuids,
    consentDbPath,
  };
  return [
    {
      name: "list_skills",
      description:
        "Discover available skills — one-line summaries. Call this FIRST when you want to do something non-trivial (share a webpage, generate media, etc.) before reaching for ad-hoc code. Follow up with `read_skill(name)` to load the full instructions.",
      inputSchema: ListInput,
      handler: (args) => {
        const q = (args.query ?? "").toLowerCase().trim();
        const db = readDb(dbPath);
        // Skills owned by an integration that is absent or switched off vanish
        // too, so the model never routes work at tools it cannot call. The
        // ownership comes from each manifest's `instructions.skills`.
        const hidden = unavailableIntegrationSkills(ctx.config);
        const entries = listSkills().filter(
          (e) => skillVisibleTo(db.skills[e.name], ctx.sessionKey) && !hidden.has(e.name),
        );
        // `query` is described as keywords, so treat it as keywords. The old
        // whole-string substring check made a real model search for
        // "radaromega weather fishing current conditions" return NOTHING —
        // not even radaromega — because no one description contained that
        // exact five-word sequence. Rank every skill that matches at least one
        // term, with exact/name matches first, so one discovery call may return
        // the two complementary playbooks a mixed question actually needs.
        const matched = q
          ? entries
              .map((entry) => ({ entry, score: skillQueryScore(q, entry) }))
              .filter(({ score }) => score > 0)
              .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
              .map(({ entry }) => entry)
          : entries;

        const rows = matched.map((e) => {
          const rec = db.skills[e.name];
          const group = skillGroupOf(rec, ctx.sessionKey);
          const flags: string[] = [];
          if (rec?.needs_approval) flags.push("needs-approval");
          // Say whose skill it is right here in the catalogue. The model
          // needs to know a consent ask is coming BEFORE it plans a turn
          // around the skill — finding out at read time means announcing a
          // plan and then asking permission for it.
          if (group === "public" && rec?.publisher) {
            const state = consentState(rec, ctx.sessionKey, consentDeps);
            flags.push(
              state.required
                ? `${rec.publisher_name ?? rec.publisher} — ask before using`
                : `${rec.publisher_name ?? rec.publisher}`,
            );
          }
          const flag = flags.length ? ` [${flags.join(", ")}]` : "";
          return { group, line: `• ${e.name}${flag} — ${e.description}` };
        });

        const wanted: SkillGroup[] = args.from ? [args.from] : SKILL_GROUPS;
        const shown = rows.filter((r) => wanted.includes(r.group));
        if (shown.length === 0) {
          const what = [q ? `"${q}"` : null, args.from ? `from ${args.from}` : null]
            .filter(Boolean)
            .join(" ");
          return text(what ? `no skills match ${what}` : "no skills installed");
        }

        // Grouped by provenance, because provenance decides what you may do
        // with a skill — edit it, publish it, or ask before reading it.
        const body = wanted
          .map((g) => {
            const groupLines = shown.filter((r) => r.group === g);
            if (groupLines.length === 0) return "";
            return `${g.toUpperCase()} (${GROUP_BLURB[g]}):\n${groupLines.map((r) => r.line).join("\n")}`;
          })
          .filter(Boolean)
          .join("\n\n");
        return text(body);
      },
    },
    {
      name: "read_skill",
      description:
        "Load the full SKILL.md for one skill (instructions, scripts, usage examples). Only call this when you've decided to use the skill — it returns the complete prompt, which is larger than the summary.",
      inputSchema: ReadInput,
      handler: (args) => {
        const path = skillManifestPath(join(SKILLS_ROOT, args.name));
        if (!existsSync(path)) return text(`no such skill: ${args.name}`, true);
        const db = readDb(dbPath);
        const rec = db.skills[args.name];
        if (rec?.disabled) {
          return text(`skill ${args.name} is disabled by operator`, true);
        }
        if (!skillVisibleTo(rec, ctx.sessionKey)) {
          // Chat-scoped skill from a different session — to this session it
          // simply doesn't exist (don't leak that another chat has one).
          return text(`no such skill: ${args.name}`, true);
        }
        if (unavailableIntegrationSkills(ctx.config).has(args.name)) {
          return text(
            `skill ${args.name} is unavailable — the integration that owns it is not installed or is disabled in config. Use a general-purpose approach instead.`,
            true,
          );
        }
        // Consent gate for published skills. This runs BEFORE the file is
        // read, and returns the ask INSTEAD of the body: a stranger's
        // instructions cannot enter context by the model forgetting to ask,
        // because they are never sent. See skills/consent.ts.
        if (rec) {
          const state = consentState(rec, ctx.sessionKey, consentDeps);
          if (state.required) {
            return text(serveAsk(rec, ctx.sessionKey, state, consentDeps));
          }
        }
        const body = readFileSync(path, "utf8");
        // Record the read. This is the only signal the harness has for which
        // skills are earning their place in the catalogue, and the retirement
        // pass depends on it. Written after every gate, so a withheld body is
        // never counted as a use.
        recordSkillRead(ctx.dataDir, args.name, ctx.sessionKey);
        if (rec?.needs_approval) {
          const banner = `[OPERATOR APPROVAL REQUIRED] This skill ships executable scripts and has NOT been approved.\nDo not run any script from this skill. Surface to the user that they need to run:\n  edmund skills approve ${args.name}\nYou may read the instructions below to understand what it does, but skip script execution steps.\n\n---\n\n`;
          return text(banner + body);
        }
        return text(body);
      },
    },
    {
      name: "create_skill",
      description:
        "Teach yourself a durable new ability by WRITING A SKILL — when you notice the same shaped request keep coming back (a recurring report, an image ritual, a multi-step task you've now done twice), crystallize the playbook into a skill so future turns just `read_skill` and execute instead of re-deriving it. Defaults to private-to-this-chat; pass share='everyone' only for fully generic skills with no personal context. Scripts are allowed but can't be executed until the operator approves (`edmund skills approve <name>`). After creating, tell the user in ONE line what you now know how to do.",
      inputSchema: CreateInput,
      handler: (args) => {
        const result = authorSkill({
          name: args.name,
          description: args.description,
          instructions: args.instructions,
          extraFiles: args.extra_files ?? [],
          scope: args.share === "everyone" ? null : ctx.sessionKey,
          // Always record where it was born, even when sharing with everyone:
          // publishing later needs an author to attribute it to.
          originScope: ctx.sessionKey,
          opts: {
            skillsRoot: resolve(SKILLS_ROOT),
            dbPath,
            requireApprovalForScripts: ctx.config.skills_marketplace.require_approval_for_scripts,
          },
        });
        if (!result.ok) return text(`create_skill failed: ${result.reason}`, true);
        const vis = result.record.scope ? "private to this chat" : "available everywhere";
        const note = result.record.needs_approval
          ? ` ⚠ it ships scripts — operator must run \`edmund skills approve ${args.name}\` before you may execute them.`
          : "";
        return text(`created skill ${args.name} (${vis}).${note}`);
      },
    },
    {
      name: "update_skill",
      description:
        "Refine a skill you authored — sharpen the instructions after a run taught you something, fix a step that didn't work, add a template file. Only works on self-authored skills visible to this chat. If the update leaves the skill holding scripts, operator approval is required again before executing them.",
      inputSchema: UpdateSkillInput,
      handler: (args) => {
        if (!args.description && !args.instructions && !args.extra_files?.length) {
          return text("provide at least one of: description, instructions, extra_files", true);
        }
        const result = updateAuthoredSkill({
          name: args.name,
          description: args.description,
          instructions: args.instructions,
          extraFiles: args.extra_files ?? [],
          sessionKey: ctx.sessionKey,
          consentDbPath,
          opts: {
            skillsRoot: resolve(SKILLS_ROOT),
            dbPath,
            requireApprovalForScripts: ctx.config.skills_marketplace.require_approval_for_scripts,
          },
        });
        if (!result.ok) return text(`update_skill failed: ${result.reason}`, true);
        const note = result.record.needs_approval
          ? " ⚠ scripts present — re-approval required before executing them."
          : "";
        const published =
          categoryOf(result.record) === "public"
            ? " It is published, so everyone who had agreed to use it will be asked again — the text they agreed to has changed."
            : "";
        return text(`updated skill ${args.name}.${note}${published}`);
      },
    },
    {
      name: "publish_skill",
      description:
        "Publish a skill THIS PERSON authored here, so everyone else who talks to you can use it too. Only do this when they ask you to share it — publishing hands their playbook to strangers, and it is theirs to give. Their skill must read as instructions for someone who has never met them: no names, numbers, addresses or details from this conversation (the publish is refused if any survive). Reversible with unpublish_skill.",
      inputSchema: PublishInput,
      handler: (args) => {
        if (!ctx.config.public_skills.enabled) {
          return text("publishing is switched off in this deployment", true);
        }
        const path = join(SKILLS_ROOT, args.name, "SKILL.md");
        if (!existsSync(path)) return text(`no such skill: ${args.name}`, true);
        const result = publishSkill({
          name: args.name,
          sessionKey: ctx.sessionKey,
          dbPath,
          consentDbPath,
          skillText: readFileSync(path, "utf8"),
          selfNames: ctx.config.identity.names,
          contacts: ctx.contacts,
        });
        if (!result.ok) return text(`publish failed: ${result.reason}`, true);
        return text(
          `published ${args.name} as ${result.record.publisher_name}. Anyone can now use it — the first time it comes up in another conversation, they'll be asked whether they want a skill from ${result.record.publisher_name}. People in a group with them are not asked.`,
        );
      },
    },
    {
      name: "unpublish_skill",
      description:
        "Take a published skill back out of circulation. It returns to being private to the chat that authored it, and every agreement other people gave to use it is forgotten.",
      inputSchema: PublishInput,
      handler: (args) => {
        const result = unpublishSkill({
          name: args.name,
          sessionKey: ctx.sessionKey,
          dbPath,
          consentDbPath,
        });
        if (!result.ok) return text(`unpublish failed: ${result.reason}`, true);
        return text(`unpublished ${args.name} — it is private to this chat again.`);
      },
    },
    {
      name: "confirm_skill_use",
      description:
        "Record what the person said when you asked whether to use someone else's published skill. Call this on the turn their ANSWER arrives, not on the turn you asked — the answer has to be theirs. On 'allow', read_skill returns the real instructions from then on, in this conversation, permanently. Never call this to grant yourself access: if they haven't answered, this is refused.",
      inputSchema: ConfirmInput,
      handler: (args) => {
        const result = recordDecision({
          skillName: args.name,
          sessionKey: ctx.sessionKey,
          decision: args.decision,
          lastInboundMs: lastInboundMs(ctx.dataDir, ctx.sessionKey),
          consentDbPath,
        });
        if (!result.ok) return text(`not recorded: ${result.reason}`, true);
        return args.decision === "allow"
          ? text(
              `recorded — ${args.name} is available in this chat now. read_skill it and get on with the task.`,
            )
          : text(
              `recorded — not using ${args.name} here. Solve it another way and don't raise it again.`,
            );
      },
    },
  ];
}

type SkillEntry = { name: string; description: string };

/** Keyword relevance for list_skills(query). Exported for the regression test
 * that pins the multi-intent query observed in Corey's fishing conversation. */
export function skillQueryScore(query: string, entry: SkillEntry): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const haystack = `${name} ${description}`;
  if (haystack.includes(q)) return 100;

  const terms = [
    ...new Set(
      q
        .match(/[a-z0-9][a-z0-9-]*/g)
        ?.filter((term) => term.length >= 2 && !SKILL_QUERY_STOP_WORDS.has(term)) ?? [],
    ),
  ];
  return terms.reduce((score, term) => {
    if (name === term) return score + 8;
    if (name.includes(term)) return score + 4;
    if (description.includes(term)) return score + 1;
    return score;
  }, 0);
}

const SKILL_QUERY_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "how",
  "into",
  "please",
  "the",
  "this",
  "use",
  "with",
]);

/**
 * The file the model reads for a skill. A gitignored `SKILL.local.md` beside
 * the tracked `SKILL.md` wins: it is where a deployment keeps the real names,
 * places and household detail that the publishable version cannot carry.
 * Publishing and editing still act on `SKILL.md`; the overlay is read only.
 */
export function skillManifestPath(dir: string): string {
  const local = join(dir, "SKILL.local.md");
  return existsSync(local) ? local : join(dir, "SKILL.md");
}

function listSkills(): SkillEntry[] {
  if (!existsSync(SKILLS_ROOT)) return [];
  const out: SkillEntry[] = [];
  for (const name of readdirSync(SKILLS_ROOT)) {
    const dir = join(SKILLS_ROOT, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = skillManifestPath(dir);
    if (!existsSync(manifest)) continue;
    const description = parseDescription(readFileSync(manifest, "utf8")) ?? "(no description)";
    out.push({ name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseDescription(md: string): string | null {
  // Frontmatter is between two `---` lines. Match `description:` value,
  // supporting single-line strings (skills don't use multi-line descriptions).
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm?.[1]) return null;
  const line = fm[1].split("\n").find((l) => l.trim().toLowerCase().startsWith("description:"));
  if (!line) return null;
  return line
    .replace(/^[^:]*:\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}
