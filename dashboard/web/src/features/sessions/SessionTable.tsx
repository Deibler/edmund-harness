import { Badge } from "@/components/ui/Badge";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { relativeTime } from "@/lib/time";
import type { SessionSummary } from "@api/types";
import { Link } from "react-router-dom";

export function SessionTable({ sessions }: { sessions: SessionSummary[] }) {
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted">
        No sessions yet — send the assistant a message from iMessage.
      </p>
    );
  }
  return (
    <Table>
      <Thead>
        <Tr>
          <Th>Session</Th>
          <Th>Kind</Th>
          <Th>Last inbound</Th>
          <Th>Last outbound</Th>
          <Th>Crons</Th>
          <Th>Agents</Th>
        </Tr>
      </Thead>
      <tbody>
        {sessions.map((s) => (
          <Tr key={s.sessionKey}>
            <Td>
              <Link
                to={`/sessions/${encodeURIComponent(s.sessionKey)}`}
                className="text-fg hover:text-accent font-medium"
              >
                {s.label}
              </Link>
              <div className="text-xs text-muted font-mono truncate max-w-[24rem]">
                {s.sessionKey}
              </div>
            </Td>
            <Td>
              <Badge tone={s.isGroup ? "accent" : "neutral"}>{s.isGroup ? "group" : "dm"}</Badge>
            </Td>
            <Td className="text-muted">{relativeTime(s.lastInboundMs)}</Td>
            <Td className="text-muted">{relativeTime(s.lastOutboundMs)}</Td>
            <Td>{s.activeCrons || <span className="text-muted">—</span>}</Td>
            <Td>{s.activeAgents || <span className="text-muted">—</span>}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
