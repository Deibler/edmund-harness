/**
 * Ghost decision MCP server — the structured-output channel for ghost ticks.
 *
 * The ghost used to emit its decision as raw JSON in its final text, which
 * was fragile (one parse error ate a real fire). Now the tick runs as a
 * tool-using agent and ends by CALLING `submit_decision` — the schema is
 * enforced at the tool layer, so a malformed decision is rejected back to
 * the model to retry instead of silently becoming act:false.
 *
 * The server writes the validated decision to GHOST_DECISION_PATH (set by
 * think.ts in this server's env) and the parent reads it after the spawn
 * exits. Stdout text becomes a fallback channel only.
 */

import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { protectStdout } from "../mcp/stdio-safety.ts";
import { type TimeGuard, validateFireTime } from "./mcp-server-validate.ts";

const DECISION_PATH = process.env.GHOST_DECISION_PATH;

/** Session active-hours, passed by think.ts so fire_at_ms can be validated
 *  AT SUBMIT TIME — the model gets a tool error and retries with a fixed
 *  time, instead of the harness silently moving (or dropping) the fire. */
const TIME_GUARD: TimeGuard = (() => {
  try {
    const raw = process.env.GHOST_TIME_GUARD;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.activeHours) || typeof parsed.timezone !== "string")
      return null;
    return parsed;
  } catch {
    return null;
  }
})();

const server = new McpServer({ name: "ghost", version: "1.0.0" });

server.tool(
  "submit_decision",
  "Submit your tick decision. Call this EXACTLY ONCE as your final action — it is the only output that counts (your text output is ignored). act:false with snooze_hours when nothing can change until the user acts; act:true with a brief (and any staged context_files) when the main model should be woken.",
  {
    act: z.boolean().describe("true = wake the main model with your brief; false = no move now."),
    reason: z
      .string()
      .optional()
      .describe("act:false only — short explanation (logged, and shown to future-you)."),
    snooze_hours: z
      .number()
      .min(0)
      .optional()
      .describe(
        "act:false only — hours before this chat should be looked at again. Set it whenever your reason implies nothing changes until the user acts ('ball in their court', 'they're away'). Any new inbound voids it early.",
      ),
    fire_at_ms: z
      .number()
      .optional()
      .describe(
        "act:true — unix-ms when the main model should be invoked. Omit for 'now'. COMPUTE AS now(epoch-ms) + offset using the TIME_CONTEXT anchors — never build an absolute epoch from a calendar date (that has landed a year in the past). Must fall inside the active-hours window.",
      ),
    brief: z
      .string()
      .optional()
      .describe(
        "act:true — the paragraph the main model wakes up with: the moment, the why-now, the specific hook, the suggested move shape. Reference any files you staged.",
      ),
    tags: z.array(z.string()).optional().describe("act:true — short telemetry labels."),
    expires_at_ms: z
      .number()
      .optional()
      .describe(
        "act:true — when this brief stops being worth firing. Omit for fire+24h. Same rule as fire_at_ms: now(epoch-ms) + offset, never a hand-built calendar epoch.",
      ),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    context_files: z
      .array(z.string())
      .optional()
      .describe(
        "act:true — ABSOLUTE paths of work you staged in the brownnose workspace (drafts, research) for the main model to pick up at fire time.",
      ),
  },
  (args) => {
    if (!DECISION_PATH) {
      return {
        content: [{ type: "text" as const, text: "GHOST_DECISION_PATH not set — decision lost" }],
        isError: true,
      };
    }
    if (args.act && (!args.brief || args.brief.trim().length === 0)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "act:true requires a non-empty brief — the main model wakes up with nothing otherwise. Retry with a brief.",
          },
        ],
        isError: true,
      };
    }
    if (args.act) {
      const timeErr = validateFireTime(args.fire_at_ms, args.expires_at_ms, Date.now(), TIME_GUARD);
      if (timeErr) {
        return { content: [{ type: "text" as const, text: timeErr }], isError: true };
      }
    }
    // Normalize to the camelCase shape think.ts's decision reader expects.
    const decision = {
      act: args.act,
      reason: args.reason,
      snoozeHours: args.snooze_hours,
      fireAtMs: args.fire_at_ms,
      brief: args.brief,
      tags: args.tags,
      expiresAtMs: args.expires_at_ms,
      confidence: args.confidence,
      contextFiles: args.context_files,
    };
    writeFileSync(DECISION_PATH, JSON.stringify(decision));
    return {
      content: [
        {
          type: "text" as const,
          text: "decision recorded — you are done; end your turn now.",
        },
      ],
    };
  },
);

// stdout is the JSON-RPC transport here too.
protectStdout();
await server.connect(new StdioServerTransport());
