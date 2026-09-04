/**
 * deep_research MCP tool — orchestrates a planner → fan-out → synthesizer
 * pipeline on top of the existing agent/team primitives.
 *
 *   1. Haiku plans `N` sub-queries from the question (heuristic fallback).
 *   2. Spawn a team of N researcher agents; park the synthesizer's task as
 *      a follow-on marker in the shared dir (src/agents/follow-on.ts).
 *   3. Each researcher writes `finding-<role>.md` to the team's shared dir.
 *   4. When the LAST researcher settles, the settle site spawns the
 *      synthesizer into the same team; it merges what's already on disk
 *      into `brief.md` + `summary.txt` — map fully done before reduce
 *      starts, no worker paid to poll for siblings.
 *   5. Tool returns the team id + plan; the single team-completion event
 *      (after the synthesizer finishes) wakes the model.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFollowOnMarker } from "../../agents/follow-on.ts";
import { type TeamMember, spawnTeam } from "../../agents/spawn.ts";
import { AgentStore } from "../../agents/store.ts";
import {
  DEPTH_FANOUT,
  type ResearchDepth,
  planHeuristic,
  planWithHaiku,
} from "../../research/planner.ts";
import {
  buildResearcherTask,
  buildSynthesizerTask,
  formatSpawnReturn,
} from "../../research/reducer.ts";
import { genId } from "../../util/ids.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const Input = z.object({
  question: z
    .string()
    .min(10)
    .max(2000)
    .describe(
      "The research question. Self-contained — the sub-agents see only this and the sub-queries derived from it.",
    ),
  depth: z
    .enum(["quick", "standard", "thorough"])
    .default("standard")
    .describe(
      "quick=2 sub-queries (~1-2 min), standard=4 (~2-4 min), thorough=6 (~4-7 min). Default 'standard'.",
    ),
  use_heuristic_planner: z
    .boolean()
    .optional()
    .describe(
      "Skip Haiku and use the deterministic heuristic decomposition. Useful when you want zero spend on planning or Haiku is unavailable.",
    ),
});

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

export function deepResearchTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "deep_research",
      description:
        "Run a multi-agent deep-research pass on a question. Plans 2-6 sibling sub-queries, fans them out across researcher sub-agents in parallel, then a synthesizer merges the findings into a single brief + a 3-bullet iMessage summary. Use this when one-shot `web_search` won't cover the angles (overview + recent news + criticism + comparisons), the user explicitly asked you to 'research' or 'dig into' something, or the answer needs to be defensible. Returns a team id immediately — the team completes asynchronously and the harness fires a team-completion event when done. Don't call this for trivial factual lookups (weather, scores, definitions); reach for `web_search` first.",
      inputSchema: Input,
      handler: async (args) => {
        const depth = args.depth as ResearchDepth;
        const fanout = DEPTH_FANOUT[depth];

        let queries: string[];
        let via: "haiku" | "heuristic";
        if (args.use_heuristic_planner) {
          queries = planHeuristic(args.question, depth);
          via = "heuristic";
        } else {
          const plan = await planWithHaiku(args.question, depth, undefined, {
            dataDir: ctx.dataDir,
            sessionKey: ctx.sessionKey,
          });
          queries = plan.queries;
          via = plan.ok ? plan.via : "heuristic";
        }
        if (queries.length === 0) {
          return text("planner produced no sub-queries — refusing to spawn empty team", true);
        }

        const store = new AgentStore(ctx.dataDir);

        // Reserve the team id + shared dir BEFORE building tasks, so every
        // task string carries the real absolute path (no placeholder seam,
        // no "<see TEAM_SHARED env var>" indirection). spawnTeam mkdir's
        // the dir again — that's idempotent.
        const teamId = genId("team");
        const sharedDir = join(ctx.sandboxPath, "teams", teamId, "shared");
        mkdirSync(sharedDir, { recursive: true });

        const members: TeamMember[] = queries.map((q, i) => ({
          role: `researcher-${i + 1}`,
          task: buildResearcherTask(q, sharedDir),
        }));

        // The synthesizer is NOT a spawned member: it runs as a follow-on,
        // spawned by whichever researcher settles last (see
        // src/agents/follow-on.ts). It joins the same team, so the single
        // team-completion event fires after IT finishes — and it never
        // burns a worker polling for siblings that haven't written yet.
        writeFollowOnMarker(sharedDir, {
          role: "synthesizer",
          task: buildSynthesizerTask(args.question, sharedDir, queries.length),
          parentSessionKey: ctx.sessionKey,
          parentSandbox: ctx.sandboxPath,
        });

        const spawned = spawnTeam(store, ctx.dataDir, ctx.sandboxPath, ctx.sessionKey, members, {
          teamId,
        });

        return text(
          formatSpawnReturn({
            question: args.question,
            teamId: spawned.teamId,
            fanout,
            sharedDir: spawned.sharedDir,
            plannerVia: via,
            queries,
          }),
        );
      },
    },
  ];
}
