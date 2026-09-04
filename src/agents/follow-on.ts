import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Team follow-on marker: a JSON file in a team's shared dir that asks for
 * ONE more agent to be spawned after the fan-out settles.
 *
 * deep_research uses this to sequence its synthesizer: researchers spawn as
 * the team, and the synthesizer spawns only when the last researcher
 * settles — instead of running concurrently and burning a worker polling
 * the shared dir "every ~30s for up to 10 minutes" waiting for siblings.
 * Because the follow-on joins the SAME team, the team-done event naturally
 * defers until it finishes: settle → spawn follow-on (team unsettled again)
 * → follow-on finishes → team settles for real → one completion event.
 *
 * Consumption is an atomic rename so two members settling simultaneously
 * can't both spawn the follow-on.
 */

export type FollowOnSpec = {
  role: string;
  task: string;
  parentSessionKey: string;
  /** The parent session's sandbox root — where agents/<id> dirs live. */
  parentSandbox: string;
};

const MARKER = ".follow-on.json";

export function writeFollowOnMarker(sharedDir: string, spec: FollowOnSpec): void {
  writeFileSync(join(sharedDir, MARKER), JSON.stringify(spec, null, 2));
}

/**
 * Atomically claim the marker. Returns the spec exactly once; every other
 * caller (and every later settle pass) gets null.
 */
export function consumeFollowOnMarker(sharedDir: string): FollowOnSpec | null {
  const path = join(sharedDir, MARKER);
  if (!existsSync(path)) return null;
  const claimed = `${path}.consumed`;
  try {
    renameSync(path, claimed);
  } catch {
    return null; // raced — someone else claimed it
  }
  try {
    const spec = JSON.parse(readFileSync(claimed, "utf8")) as FollowOnSpec;
    if (!spec.role || !spec.task || !spec.parentSessionKey || !spec.parentSandbox) return null;
    return spec;
  } catch {
    return null;
  }
}

/**
 * Derive a team's shared dir from any member's sandbox path. Layout is
 * defined by spawnAgent/spawnTeam in spawn.ts:
 *   member sandbox: <parentSandbox>/agents/<agentId>
 *   team shared:    <parentSandbox>/teams/<teamId>/shared
 */
export function teamSharedDirFor(memberSandboxPath: string, teamId: string): string {
  const parentSandbox = dirname(dirname(memberSandboxPath));
  return join(parentSandbox, "teams", teamId, "shared");
}
