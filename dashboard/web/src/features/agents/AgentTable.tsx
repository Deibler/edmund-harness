import { Table, Th, Thead, Tr } from "@/components/ui/Table";
import type { AgentDto } from "@api/types";
import { AgentRow } from "./AgentRow";

export function AgentTable({
  agents,
  showSession = true,
}: {
  agents: AgentDto[];
  showSession?: boolean;
}) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted">No agents yet.</p>;
  }
  return (
    <Table>
      <Thead>
        <Tr>
          {showSession ? <Th>Session</Th> : null}
          <Th>Status</Th>
          <Th>Task</Th>
          <Th>Started</Th>
          <Th>Finished</Th>
          <Th />
        </Tr>
      </Thead>
      <tbody>
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} showSession={showSession} />
        ))}
      </tbody>
    </Table>
  );
}
