import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseSchedule } from "../../cron/parse.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Standing missions — model-driven watchers with a contract.
 *
 * A mission is a recurring cron whose system event carries the full
 * mission brief (objective, how to check, when to speak up) plus a
 * per-mission notes file in `sandbox/missions/<slug>.md` where the model
 * keeps state between checks (baseline price, last score seen, etc.).
 *
 * The defining discipline vs. a plain reminder: routine checks are
 * SILENT. The user hears from a mission only when something happened —
 * the condition fired, a meaningful delta showed up, or the mission
 * wraps. That's what makes "keep an eye on it" feel like delegation
 * instead of subscription spam.
 */

const MISSION_PREFIX = "[Mission ";
const MISSION_RE = /^\[Mission ([a-z0-9][a-z0-9-]*)\]/;
const DEFAULT_GRACE_MS = 60 * 60 * 1000; // recurring checks: skip if >1h stale

const StartInput = z.object({
  name: z
    .string()
    .describe("Short human name, e.g. 'eBay reel price watch'. A slug is derived from it."),
  objective: z
    .string()
    .describe(
      "What the user actually wants out of this, in one or two sentences. E.g. 'Tell the operator if the Shimano reel listing drops under $200 so they can grab it.'",
    ),
  check_instructions: z
    .string()
    .describe(
      "Exactly how future-you runs one check: which tool calls, which URL/query, what to compare against the notes file. Be concrete — future-you starts cold.",
    ),
  cadence: z
    .string()
    .describe(
      'How often to check: a 5-field cron like "0 9,17 * * *" (also accepted as "every:0 9,17 * * *"), or "in 2 hours" for a single delayed check. Match the cadence to how fast the thing actually changes.',
    ),
  report_when: z
    .string()
    .describe(
      "The speak-up condition: when does the user hear from you? E.g. 'price < $200, or listing ends/disappears'. Everything else is a silent check.",
    ),
  wrap_up_by: z
    .string()
    .optional()
    .describe(
      "Optional natural end, e.g. '2026-06-20' or 'once the game ends'. When reached, deliver a final word and end the mission.",
    ),
});

const EndInput = z.object({
  slug: z.string().describe("Mission slug from list_missions."),
  resolution: z
    .string()
    .describe("One line on how it ended — condition met, expired, user called it off."),
});

export function missionTools(ctx: ToolContext): ToolDef[] {
  const notesDir = join(ctx.sandboxPath, "missions");

  return [
    {
      name: "start_mission",
      description:
        "Stand up a STANDING MISSION — 'keep an eye on it' delegation with a real contract. Use when the user wants to be told when something changes or happens: a price drop, a score, a listing, a flight, a forecast shift, a site update. You'll be woken on the cadence you set, run the check, keep state in a notes file, and message the user ONLY when the report condition hits (routine checks are silent). Deliver the OUTCOME when it fires ('it dropped to $189, link: …'), not a notification to go look. After starting, tell the user in one short line what's now running and when you'll check. Don't use for simple time-based reminders — that's schedule_reminder.",
      inputSchema: StartInput,
      handler: (args) => {
        const slug = slugify(args.name);
        if (!slug) return err("couldn't derive a slug from that name — use some letters/digits");
        const existing = ctx.cron
          .listActive(ctx.sessionKey)
          .find((j) => parseMissionSlug(j.systemEvent) === slug);
        if (existing)
          return err(
            `a mission with slug '${slug}' is already running (job ${existing.id}) — end_mission it first or pick another name`,
          );

        let schedule: ReturnType<typeof parseSchedule>;
        try {
          schedule = parseSchedule(args.cadence);
        } catch (e) {
          return err(`bad cadence: ${(e as Error).message}`);
        }

        const notesPath = join(notesDir, `${slug}.md`);
        if (!existsSync(notesPath)) {
          mkdirSync(notesDir, { recursive: true });
          writeFileSync(
            notesPath,
            [
              `# Mission: ${args.name}`,
              "",
              `Objective: ${args.objective}`,
              `Report when: ${args.report_when}`,
              args.wrap_up_by ? `Wrap up by: ${args.wrap_up_by}` : null,
              "",
              "## Check log",
              "",
            ]
              .filter((l): l is string => l !== null)
              .join("\n"),
          );
        }

        const event = buildMissionEvent({
          slug,
          name: args.name,
          objective: args.objective,
          checkInstructions: args.check_instructions,
          reportWhen: args.report_when,
          wrapUpBy: args.wrap_up_by ?? null,
          notesPath,
        });

        const job = ctx.cron.create({
          sessionKey: ctx.sessionKey,
          systemEvent: event,
          schedule,
          gracePeriodMs: DEFAULT_GRACE_MS,
        });
        return ok(
          `mission '${slug}' started — first check ${new Date(job.nextFireMs).toISOString()}, notes at ${notesPath}. Tell the user in one line what you're now watching.`,
        );
      },
    },
    {
      name: "list_missions",
      description:
        "List the standing missions running in this conversation — slug, what each is watching, and the next check time.",
      inputSchema: z.object({}),
      handler: () => {
        const jobs = ctx.cron
          .listActive(ctx.sessionKey)
          .filter((j) => j.systemEvent.startsWith(MISSION_PREFIX));
        if (jobs.length === 0) return ok("no standing missions");
        const lines = jobs.map((j) => {
          const slug = parseMissionSlug(j.systemEvent) ?? "?";
          const objective = j.systemEvent.match(/^Objective: (.*)$/m)?.[1] ?? "";
          return `• ${slug} — ${objective} — next check ${new Date(j.nextFireMs).toISOString()}`;
        });
        return ok(lines.join("\n"));
      },
    },
    {
      name: "end_mission",
      description:
        "Conclude a standing mission — the condition fired and you delivered the outcome, it expired, or the user called it off. Cancels the recurring check and closes the notes file. Always deliver the final word to the user BEFORE ending (unless they explicitly told you to drop it silently).",
      inputSchema: EndInput,
      handler: (args) => {
        const jobs = ctx.cron
          .listActive(ctx.sessionKey)
          .filter((j) => parseMissionSlug(j.systemEvent) === args.slug);
        if (jobs.length === 0) return err(`no active mission with slug '${args.slug}'`);
        for (const j of jobs) ctx.cron.cancel(j.id);
        const notesPath = join(notesDir, `${args.slug}.md`);
        if (existsSync(notesPath)) {
          const stamp = new Date().toISOString();
          writeFileSync(notesPath, `\n## Resolved ${stamp}\n${args.resolution}\n`, { flag: "a" });
        }
        return ok(`mission '${args.slug}' ended: ${args.resolution}`);
      },
    },
  ];
}

export function parseMissionSlug(systemEvent: string): string | null {
  return systemEvent.match(MISSION_RE)?.[1] ?? null;
}

export function buildMissionEvent(args: {
  slug: string;
  name: string;
  objective: string;
  checkInstructions: string;
  reportWhen: string;
  wrapUpBy: string | null;
  notesPath: string;
}): string {
  const lines = [
    `[Mission ${args.slug}] ${args.name} — scheduled check`,
    "",
    `Objective: ${args.objective}`,
    `Report when: ${args.reportWhen}`,
    ...(args.wrapUpBy ? [`Wrap up by: ${args.wrapUpBy}`] : []),
    `Notes file: ${args.notesPath}`,
    "",
    "How to run this check:",
    args.checkInstructions.trim(),
    "",
    "Then:",
    "1. Read the notes file for prior state, append one dated line with what this check found.",
    "2. If the report condition is NOT met and nothing meaningfully changed: output NOTHING.",
    `   Empty turn, zero text — a silent check is the normal outcome, and any "no news yet"`,
    "   message would spam the user. Do not narrate the silence.",
    "3. If the report condition IS met or something the user would genuinely want to know",
    "   happened: message them leading with the finding itself (the price, the score, the",
    `   link), not with "mission update".`,
    "4. If the objective is complete, hopeless, or past its wrap-up point: deliver the final",
    `   word, then call end_mission(slug: "${args.slug}", resolution: "...").`,
  ];
  return lines.join("\n");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
