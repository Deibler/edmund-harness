import { z } from "zod";
import { parseSchedule } from "../../cron/parse.ts";
import type { JobSchedule } from "../../cron/types.ts";
import { describeCadence, describeEastern, humanDelta } from "../../util/clock.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const DEFAULT_GRACE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The confirmation the model reads back after scheduling/updating a job. It
 * spells out, all in Eastern (the owner's home clock):
 *   - whether the job is one-time or recurring (and, if recurring, the cadence)
 *   - the exact wall-clock moment it will fire, plus how far out that is
 *   - what time it is RIGHT NOW
 * so the model can eyeball "fires" against "right now" and catch a mis-computed
 * date (e.g. it meant "tomorrow" but the fire lands two days out) before the
 * user ever notices a missed reminder.
 */
function confirmBlock(opts: {
  header: string;
  schedule: JobSchedule;
  nextFireMs: number;
  gracePeriodMs: number | null;
  event?: string;
}): string {
  const now = Date.now();
  const lines = [opts.header];
  if (opts.schedule.kind === "cron") {
    lines.push(`  type: recurring — ${describeCadence(opts.schedule.expr, opts.nextFireMs)}`);
    lines.push(
      `  next fire: ${describeEastern(new Date(opts.nextFireMs))} (${humanDelta(now, opts.nextFireMs)})`,
    );
  } else {
    lines.push("  type: one-time");
    lines.push(
      `  fires: ${describeEastern(new Date(opts.nextFireMs))} (${humanDelta(now, opts.nextFireMs)})`,
    );
  }
  lines.push(`  right now: ${describeEastern(new Date(now))}`);
  if (opts.gracePeriodMs != null)
    lines.push(`  grace: ${Math.round(opts.gracePeriodMs / 60_000)}m`);
  if (opts.event) {
    const ev = opts.event.length > 80 ? `${opts.event.slice(0, 80)}…` : opts.event;
    lines.push(`  event: ${ev}`);
  }
  lines.push("");
  lines.push(
    `Confirmed set. Check "fires" against "right now" above — same timezone (Eastern). If the day/date isn't what the user asked for, cancel and reschedule; don't assume it's right.`,
  );
  return lines.join("\n");
}

const ScheduleInput = z.object({
  when: z
    .string()
    .describe(
      'Natural schedule: "in 5 minutes", "in 2 hours", "at 2026-04-20T09:00:00-05:00", or a 5-field cron like "0 9 * * *" (also accepted as "every:0 9 * * *").',
    ),
  event: z
    .string()
    .describe(
      "Message delivered to you when the job fires. Write it as the event you'll react to, e.g. 'Reminder: stand up' or 'Morning brief due'.",
    ),
  grace_minutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "How many minutes late this job may still fire. If the daemon restarts after this window the job is skipped rather than delivered stale. Default: 30 minutes (good for morning briefs and daily summaries). Set to 0 to always fire no matter how late.",
    ),
});

const UpdateInput = z.object({
  id: z.string().describe("Job id from list_reminders."),
  when: z
    .string()
    .optional()
    .describe(
      "New schedule — same format as schedule_reminder. Omit to keep the current schedule.",
    ),
  event: z.string().optional().describe("New event text. Omit to keep the current event."),
  grace_minutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Update the grace window in minutes. Omit to keep the current value."),
});

const ListInput = z.object({}).optional();

const CancelInput = z.object({ id: z.string() });

const PokeInput = z.object({
  in_seconds: z
    .number()
    .int()
    .min(10)
    .max(300)
    .describe("When to fire the poke, in seconds from now. Minimum 10, maximum 300 (5 minutes)."),
  note: z
    .string()
    .optional()
    .describe(
      "Optional short note on what you were doing, surfaced to you when the poke fires. Example: 'generating Artemis summary'.",
    ),
});

export function cronTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "schedule_reminder",
      description:
        "Schedule a future action in THIS conversation. When the time comes, you (the same model session) will be resumed and handed the `event` text as if it just arrived. Use for reminders, morning briefs, check-ins, recurring prompts. Defaults to a 30-minute grace window — if the daemon is down and restarts late, stale morning briefs are skipped automatically. The tool echoes back the resolved fire time and the current time, both in Eastern (the owner's timezone) — ALWAYS read that echo and confirm the day/date is what the user asked for before moving on.",
      inputSchema: ScheduleInput,
      handler: (args) => {
        const schedule = parseSchedule(args.when);
        const gracePeriodMs =
          args.grace_minutes !== undefined ? args.grace_minutes * 60_000 : DEFAULT_GRACE_MS;
        const job = ctx.cron.create({
          sessionKey: ctx.sessionKey,
          systemEvent: args.event,
          schedule,
          gracePeriodMs,
        });
        return {
          content: [
            {
              type: "text",
              text: confirmBlock({
                header: `scheduled id=${job.id}`,
                schedule: job.schedule,
                nextFireMs: job.nextFireMs,
                gracePeriodMs: job.gracePeriodMs,
                event: args.event,
              }),
            },
          ],
        };
      },
    },
    {
      name: "update_reminder",
      description:
        "Update an existing scheduled job — change its time, its event text, or both. Use when the user wants to reschedule ('move the morning brief to 9am'), change what it does ('make it shorter'), or adjust the grace window. Provide at least one of when / event / grace_minutes.",
      inputSchema: UpdateInput,
      handler: (args) => {
        if (!args.when && !args.event && args.grace_minutes === undefined) {
          return {
            content: [
              { type: "text", text: "provide at least one of: when, event, grace_minutes" },
            ],
            isError: true,
          };
        }
        const schedule = args.when ? parseSchedule(args.when) : undefined;
        const gracePeriodMs =
          args.grace_minutes !== undefined ? args.grace_minutes * 60_000 : undefined;
        const updated = ctx.cron.update(args.id, {
          schedule,
          systemEvent: args.event,
          gracePeriodMs,
        });
        if (!updated) {
          return {
            content: [{ type: "text", text: `job ${args.id} not found or not active` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: confirmBlock({
                header: `updated id=${updated.id}`,
                schedule: updated.schedule,
                nextFireMs: updated.nextFireMs,
                gracePeriodMs: updated.gracePeriodMs,
                event: args.event ?? updated.systemEvent,
              }),
            },
          ],
        };
      },
    },
    {
      name: "list_reminders",
      description: "List active scheduled events for this conversation.",
      inputSchema: ListInput,
      handler: () => {
        const jobs = ctx.cron.listActive(ctx.sessionKey);
        const now = Date.now();
        if (jobs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `no active reminders\nright now: ${describeEastern(new Date(now))}`,
              },
            ],
          };
        }
        const lines = jobs.map((j) => {
          const graceMin =
            j.gracePeriodMs !== null ? `  grace=${Math.round(j.gracePeriodMs / 60_000)}m` : "";
          const kind =
            j.schedule.kind === "cron"
              ? `recurring (${describeCadence(j.schedule.expr, j.nextFireMs)})`
              : "one-time";
          const ev = j.systemEvent.length > 60 ? `${j.systemEvent.slice(0, 60)}…` : j.systemEvent;
          return `${j.id}  ${kind}\n    fires ${describeEastern(new Date(j.nextFireMs))} (${humanDelta(now, j.nextFireMs)})${graceMin}\n    event=${ev}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `right now: ${describeEastern(new Date(now))}\n\n${lines.join("\n")}`,
            },
          ],
        };
      },
    },
    {
      name: "poke",
      description:
        "Schedule a one-time self-poke up to 5 minutes out. Use as a safety catch-all before slow work (long generation, multi-step research) so you're guaranteed to be re-invoked to review even if the current turn stalls or errors. Fires exactly once — this is empirical, not recurring. The poke resumes this same session with a short self-note; on wake-up, check on the in-progress task and respond/recover as needed.",
      inputSchema: PokeInput,
      handler: (args) => {
        const note = args.note ? ` — ${args.note}` : "";
        const job = ctx.cron.create({
          sessionKey: ctx.sessionKey,
          systemEvent: [
            `Self-poke: review in-progress work${note}.`,
            ``,
            `If the task already completed and a reply was delivered (by you, by an agent-completion event, or by any other path), DO NOTHING — produce an empty turn with NO text output. Do not send a follow-up. Do not say "already sent" or "no action needed" — just stay silent.`,
            ``,
            `Only reply if something genuinely stalled or errored and the user is still waiting on you. In that case, recover and reply with the result or a short apology.`,
          ].join("\n"),
          schedule: { kind: "once", atMs: Date.now() + args.in_seconds * 1000 },
          gracePeriodMs: null, // pokes must always fire — no grace
        });
        return {
          content: [
            {
              type: "text",
              text: `poke scheduled id=${job.id}\n  fires: ${describeEastern(new Date(job.nextFireMs))} (${humanDelta(Date.now(), job.nextFireMs)})\n  right now: ${describeEastern(new Date())}`,
            },
          ],
        };
      },
    },
    {
      name: "cancel_reminder",
      description: "Cancel a scheduled event by id (from list_reminders).",
      inputSchema: CancelInput,
      handler: (args) => {
        const ok = ctx.cron.cancel(args.id);
        return {
          content: [{ type: "text", text: ok ? `canceled ${args.id}` : `not found: ${args.id}` }],
        };
      },
    },
  ];
}
