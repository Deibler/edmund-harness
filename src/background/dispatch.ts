import { resolve } from "node:path";
import type { ToolContext } from "../mcp/context.ts";
import { BG_EXECUTORS } from "./registry.ts";
import { spawnBgJob } from "./spawn.ts";

/**
 * Shared dispatch logic for MCP tool handlers that support async mode.
 *
 * When `args.async === true`: spawn a detached runner and return immediately
 * with a job id. The runner fires a cron wake-up when done — model is
 * invoked again with the result path in the envelope.
 *
 * Otherwise: call the registered executor inline and return the summary
 * synchronously. Handlers that need a special inline format (e.g. text only,
 * no path) can skip this and call the executor directly.
 */

export async function dispatchOrRun(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (args.async === true) {
    try {
      const job = spawnBgJob({
        store: ctx.bgJobs,
        crons: ctx.cron,
        dataDir: ctx.dataDir,
        sessionKey: ctx.sessionKey,
        sandboxPath: ctx.sandboxPath,
        toolName,
        args,
        configPath: process.env.EDMUND_CONFIG_PATH ?? resolve("./config.toml"),
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `Background job started: ${job.id}`,
              `Tool: ${toolName}`,
              ``,
              `This runs in the background — your session is no longer blocked. You'll be woken up automatically when it completes, and the result will be in that wake-up envelope. End your turn now so the user can keep messaging.`,
              ``,
              `Check status: check_bg_job("${job.id}")`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to start background job: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Inline run via the same executor
  const executor = BG_EXECUTORS[toolName];
  if (!executor) {
    return {
      content: [{ type: "text", text: `Tool ${toolName} has no executor registered` }],
      isError: true,
    };
  }
  try {
    const result = await executor(args, {
      config: ctx.config,
      sandboxPath: ctx.sandboxPath,
      sessionKey: ctx.sessionKey,
      dataDir: ctx.dataDir,
    });
    return { content: [{ type: "text", text: result.summary }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}
