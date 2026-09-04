import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Td, Tr } from "@/components/ui/Table";
import { relativeTime } from "@/lib/time";
import type { AgentDto } from "@api/types";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAgentLog, useAgentResult, useCancelAgent } from "./useAgents";

const toneByStatus: Record<AgentDto["status"], "neutral" | "accent" | "ok" | "warn" | "danger"> = {
  pending: "neutral",
  running: "accent",
  done: "ok",
  failed: "danger",
  canceled: "warn",
};

export function AgentRow({
  agent,
  showSession = true,
}: { agent: AgentDto; showSession?: boolean }) {
  const [open, setOpen] = useState(false);
  const result = useAgentResult(open ? agent.id : undefined);
  const log = useAgentLog(open ? agent.id : undefined);
  const cancel = useCancelAgent();
  const live = agent.status === "running" || agent.status === "pending";
  return (
    <>
      <Tr>
        {showSession ? (
          <Td>
            <Link
              to={`/sessions/${encodeURIComponent(agent.parentSessionKey)}`}
              className="text-fg hover:text-accent"
            >
              {agent.parentSessionLabel}
            </Link>
          </Td>
        ) : null}
        <Td>
          <Badge tone={toneByStatus[agent.status]}>{agent.status}</Badge>
        </Td>
        <Td className="max-w-[30rem]">
          <span className="text-fg">{agent.taskPreview}</span>
          {agent.teamId ? (
            <span className="text-xs text-muted ml-2">
              team:{agent.teamId.slice(0, 8)} role:{agent.role ?? "?"}
            </span>
          ) : null}
        </Td>
        <Td className="text-muted whitespace-nowrap">{relativeTime(agent.spawnedAt)}</Td>
        <Td className="text-muted whitespace-nowrap">
          {agent.finishedAt ? relativeTime(agent.finishedAt) : "—"}
        </Td>
        <Td>
          <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "View"}
          </Button>
          {live ? (
            <Button
              size="sm"
              variant="danger"
              className="ml-2"
              onClick={() => cancel.mutate(agent.id)}
            >
              Cancel
            </Button>
          ) : null}
        </Td>
      </Tr>
      {open ? (
        <Tr>
          <Td colSpan={showSession ? 6 : 5}>
            <div className="grid md:grid-cols-2 gap-3 p-2">
              <div>
                <div className="text-xs text-muted mb-1">Result</div>
                <pre className="text-xs bg-bg border border-border rounded-md p-3 max-h-60 overflow-auto whitespace-pre-wrap">
                  {result.data?.text || "(no result yet)"}
                </pre>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Log (tail)</div>
                <pre className="text-xs bg-bg border border-border rounded-md p-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono">
                  {log.data?.text || "(no log)"}
                </pre>
              </div>
            </div>
          </Td>
        </Tr>
      ) : null}
    </>
  );
}
