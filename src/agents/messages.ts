import type { AgentStore } from "./store.ts";

/**
 * Shared message builders for agent-completion wake-up events. Used by
 * agent-runner.ts (normal exit path), spawn.ts (pre-start failure path),
 * and reaper.ts (zombie-sweep path) so Edmund sees the same event shape
 * regardless of how the agent died.
 */

export function agentCompletionMessage(
  agentId: string,
  task: string,
  status: string,
  note?: string,
): string {
  const lines = [
    `A sub-agent you spawned has finished (status: ${status}).`,
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
      : `The agent did not complete successfully. Check the log with \`check_agent("${agentId}")\` to see what happened, then tell the user.`,
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
    `An agent team has finished${failed.length > 0 ? ` (${done.length} done, ${failed.length} failed)` : ""}.`,
    ``,
    `Team id: ${teamId}`,
    `Members:`,
    ...lines,
    ``,
    ...resultLines,
  ].join("\n");
}
