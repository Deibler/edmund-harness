import type { CronStore } from "../cron/store.ts";
import type { AgentStore } from "./store.ts";

/**
 * Shared message builders for agent-completion wake-up events. Used by
 * agent-runner.ts (normal exit path), spawn.ts (pre-start failure path),
 * and reaper.ts (zombie-sweep path) so Edmund sees the same event shape
 * regardless of how the agent died.
 */

const SOLO_HEAD = "A sub-agent you spawned has finished";
const TEAM_HEAD = "An agent team has finished";
const MERGED_HEAD = "Several sub-agent results arrived together";

export function agentCompletionMessage(
  agentId: string,
  task: string,
  status: string,
  note?: string,
): string {
  const lines = [
    `${SOLO_HEAD} (status: ${status}).`,
    ``,
    `Agent id: ${agentId}`,
    `Task was: ${task}`,
  ];
  if (note) {
    lines.push(``, `Note: ${note}`);
  }
  lines.push(
    ``,
    status === "done"
      ? `Read the result with \`read_agent_result("${agentId}")\` and relay it to the user.`
      : `The agent did not complete successfully. Whatever it produced is in \`read_agent_result("${agentId}")\`; \`check_agent("${agentId}")\` shows the log tail. Tell the user what came through and what didn't.`,
    `Lead with the takeaway. Reformat for iMessage bubbles per your rules.`,
    `Don't paste the raw output.`,
  );
  return lines.join("\n");
}

export function teamCompletionMessage(teamId: string, agentStore: AgentStore): string {
  const members = agentStore.listTeam(teamId);
  const done = members.filter((m) => m.status === "done");
  const failed = members.filter((m) => m.status === "failed");
  const other = members.filter((m) => m.status !== "done" && m.status !== "failed");
  const lines = members.map((m) => `  - ${m.role ?? "member"} (${m.id}): ${m.status}`);
  const resultLines = [`Use \`read_team_results("${teamId}")\` to read all results at once.`];
  if (failed.length > 0) {
    resultLines.push(
      `${failed.length} member(s) failed — their partial output is still readable. Synthesize what succeeded and tell the user plainly which part didn't come through.`,
    );
  }
  if (other.length > 0) {
    resultLines.push(
      `${other.length} member(s) are in an unexpected state: ${other.map((m) => `${m.role ?? m.id}=${m.status}`).join(", ")}.`,
    );
  }
  resultLines.push(
    `Reformat for iMessage bubbles. If members contradict, flag it; don't paper over it.`,
  );
  return [
    `${TEAM_HEAD}${failed.length > 0 ? ` (${done.length} done, ${failed.length} failed)` : ""}.`,
    ``,
    `Team id: ${teamId}`,
    `Members:`,
    ...lines,
    ``,
    ...resultLines,
  ].join("\n");
}

/** An agent or team completion event, single or already merged. */
export function isCompletionEvent(event: string): boolean {
  return [SOLO_HEAD, TEAM_HEAD, MERGED_HEAD].some((head) => event.startsWith(head));
}

/**
 * One event for completions that land together. A fan-out of solo agents
 * used to wake the parent once per agent: 85 of 234 completion wake-ups
 * since May arrived within two minutes of another for the same chat, up to
 * 19 in a row, each a full turn.
 */
export function mergeCompletionEvents(pending: string, next: string): string {
  const blocks = pending.startsWith(MERGED_HEAD)
    ? pending.split(/\n\n--- \d+ ---\n/).slice(1)
    : [pending];
  blocks.push(next);
  return [
    `${MERGED_HEAD} (${blocks.length}). Handle them in one reply: lead with what matters most, and don't send a separate message per result.`,
    ...blocks.map((b, i) => `\n--- ${i + 1} ---\n${b}`),
  ].join("\n");
}

/** Fire this long after the latest completion in a burst... */
export const COMPLETION_DEBOUNCE_MS = 20_000;
/** ...and never later than this after the first. */
export const COMPLETION_MAX_WAIT_MS = 90_000;

/**
 * The one way an agent completion reaches the parent session: merged into a
 * completion wake-up that has not fired yet, or scheduled as a new one.
 * Measured on 234 past completions: 49 fewer wake-up turns, and a lone
 * completion fires about 18s later than the 2s it used to.
 */
export function queueCompletionWakeUp(
  crons: Pick<CronStore, "coalesceOnce" | "cancelPokes">,
  sessionKey: string,
  event: string,
): number {
  crons.coalesceOnce({
    sessionKey,
    systemEvent: event,
    delayMs: COMPLETION_DEBOUNCE_MS,
    maxDelayMs: COMPLETION_MAX_WAIT_MS,
    canMerge: isCompletionEvent,
    merge: mergeCompletionEvents,
  });
  // A self-poke was only a safety net for the work that just finished.
  return crons.cancelPokes(sessionKey);
}
