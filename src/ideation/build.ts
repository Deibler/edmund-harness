import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../agents/spawn.ts";
import type { AgentStore } from "../agents/store.ts";
import { toolEnv } from "../claude/mcp-config.ts";
import type { Config } from "../config/config.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import { log } from "../util/log.ts";
import type { Pick } from "./ideator.ts";
import { type Ideation, type IdeationStore, newIdeationId } from "./store.ts";

/**
 * Start the build of a picked ideation: a row in `building`, then a detached
 * sub-agent (it survives a daemon restart) that makes the page from the
 * template, runs the publish check until it passes, and stops. Its end is
 * settled by settle.ts, never by the ordinary "relay the result" wake-up.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = join(ROOT, "dashboard", "ideation-template");
const PUBLISH = join(ROOT, "scripts", "ideation-publish.ts");

export function builderTask(i: Ideation, name: string): string {
  return [
    `Build a web page for ${name} and publish it. You are working for Edmund in the background, and ${name} did not ask for this: it is a surprise made from questions they keep asking. Do not message anyone. Edmund sends the link once the page is published.`,
    "",
    `Ideation id: ${i.id}`,
    `Title: ${i.title}`,
    `What it is: ${i.pitch}`,
    `Why: ${i.why}`,
    `They asked about it on: ${i.days.join(", ")}`,
    "",
    "The brief:",
    i.brief,
    "",
    "How to build it:",
    `1. rsync -a --exclude node_modules --exclude dist "${TEMPLATE}/" ./page/`,
    "2. Read ./page/DESIGN.md in full before writing anything. It is the standard the page is held to: shadcn components, the sandbox's limits, and the design rules (no left accent borders, no gradient text, no emoji, none of the stock AI layouts).",
    "3. cd page && bun install",
    "4. Write src/App.tsx and its components, and restyle src/index.css for this subject. Controls come from src/components/ui (add more with bunx shadcn@latest add <name>). Add only libraries DESIGN.md lists.",
    "5. bun run build",
    `6. Look at it before publishing: bun "${PUBLISH}" --check dist/index.html writes the whole page as phone-width pictures, one per screen, next to the file. Open every one and judge it against DESIGN.md as a demanding designer would. Fix what is weak and rebuild.`,
    `7. bun "${PUBLISH}" ${i.id} "$PWD/dist/index.html" checks the page at phone width and refuses it with a numbered list of problems. Fix every one, rebuild, and run it again until it prints "published:".`,
    "",
    "Facts come only from the brief and from what you verify while building (you may search and fetch the web now; the page cannot later). Say so on the page wherever something is approximate.",
    "Aim to finish within about 20 minutes.",
    "",
    'Your final answer is one line: "PUBLISHED <url>" or "FAILED <what stopped you>".',
  ].join("\n");
}

export type BuildDeps = {
  config: Config;
  store: IdeationStore;
  agents: AgentStore;
};

/** Record the pick and start its builder. Returns the row (failed if the builder could not start). */
export function startBuild(
  deps: BuildDeps,
  sessionKey: string,
  pick: Pick,
  name: string,
  nowMs = Date.now(),
): Ideation {
  const row = deps.store.create({
    id: newIdeationId(),
    sessionKey,
    thread: pick.thread,
    threadKey: pick.threadKey,
    title: pick.title,
    pitch: pick.pitch,
    why: pick.why,
    brief: pick.brief,
    evidence: pick.evidence,
    days: pick.days,
    createdMs: nowMs,
  });
  try {
    const agent = spawnAgent(
      deps.agents,
      deps.config.paths.data_dir,
      ensureSandbox(sessionKey, null),
      { parentSessionKey: sessionKey, task: builderTask(row, name), role: "ideation" },
      undefined,
      (key, sandbox) => ({
        ...toolEnv(deps.config, key, sandbox),
        EDMUND_SPEND_SUBSYSTEM: "ideation",
      }),
    );
    deps.store.setAgent(row.id, agent.id);
    log.info("ideation", "build started", {
      session: sessionKey,
      id: row.id,
      agent: agent.id,
      title: row.title,
    });
  } catch (err) {
    deps.store.markFailed(row.id, `the builder could not start: ${(err as Error).message}`);
    log.warn("ideation", "build could not start", {
      session: sessionKey,
      err: (err as Error).message,
    });
  }
  return deps.store.get(row.id) as Ideation;
}
