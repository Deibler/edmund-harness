import { z } from "zod";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const CheckInput = z.object({
  // Named `job_id` because that is what the system prompt documents
  // (`check_bg_job(job_id)`) and what every log line calls it. It was `id`,
  // so the model wrote what it had been told and the call was rejected.
  job_id: z.string().describe("Background job id from an async CF tool call."),
});

const ListInput = z
  .object({
    status: z
      .enum(["pending", "running", "done", "failed"])
      .optional()
      .describe("Filter by status."),
  })
  .optional();

export function backgroundTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "check_bg_job",
      description:
        "Check the status of a background tool job (from an async CF tool call). Returns status (pending/running/done/failed), tool name, result path, and summary if finished. You normally don't need this — completed jobs fire an automatic wake-up event with the result already included.",
      inputSchema: CheckInput,
      handler: (args) => {
        const job = ctx.bgJobs.get(args.job_id);
        // A job belongs to the session that started it. Another session's id
        // reads as unknown rather than as forbidden, so existence does not leak.
        if (!job || job.sessionKey !== ctx.sessionKey) {
          return {
            content: [{ type: "text", text: `No bg job with id ${args.job_id}` }],
            isError: true,
          };
        }
        const dur =
          job.startedAt && job.finishedAt
            ? `${Math.round((job.finishedAt - job.startedAt) / 1000)}s`
            : job.startedAt
              ? `${Math.round((Date.now() - job.startedAt) / 1000)}s running`
              : "pending";
        const lines = [
          `Job ${job.id} (${job.toolName})`,
          `  status: ${job.status}`,
          `  duration: ${dur}`,
        ];
        if (job.resultPath) lines.push(`  result: ${job.resultPath}`);
        if (job.errorText) lines.push(`  error: ${job.errorText}`);
        if (job.resultSummary) lines.push(``, job.resultSummary);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
    {
      name: "list_bg_jobs",
      description:
        "List recent background tool jobs for this conversation (newest first). Use when the user asks 'what are you working on?' or to surface in-flight work.",
      inputSchema: ListInput,
      handler: (args) => {
        const jobs = ctx.bgJobs.listForSession(ctx.sessionKey, 20);
        const filtered = args?.status ? jobs.filter((j) => j.status === args.status) : jobs;
        if (filtered.length === 0) {
          return { content: [{ type: "text", text: "no background jobs" }] };
        }
        const lines = filtered.map((j) => {
          const age = Math.round((Date.now() - j.createdAt) / 1000);
          const ageStr =
            age < 60
              ? `${age}s`
              : age < 3600
                ? `${Math.round(age / 60)}m`
                : `${Math.round(age / 3600)}h`;
          return `${j.id}  ${j.toolName}  status=${j.status}  age=${ageStr}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
  ];
}
