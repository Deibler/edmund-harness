import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { AgentTable } from "@/features/agents/AgentTable";
import { useAgents } from "@/features/agents/useAgents";
import type { AgentDto } from "@api/types";
import { useMemo, useState } from "react";

const filters: Array<{ label: string; value: AgentDto["status"] | "all" }> = [
  { label: "All", value: "all" },
  { label: "Active", value: "running" },
  { label: "Done", value: "done" },
  { label: "Failed", value: "failed" },
  { label: "Canceled", value: "canceled" },
];

export function AgentsPage() {
  const [status, setStatus] = useState<(typeof filters)[number]["value"]>("all");
  const { data, isLoading } = useAgents(status === "all" ? undefined : { status });
  const agents = useMemo(() => data?.agents ?? [], [data]);
  return (
    <div>
      <PageHeader
        title="Agents"
        description="Sub-agents spawned by the main loop. Expand a row to view result + log."
        actions={
          <div className="flex gap-1">
            {filters.map((f) => (
              <Button
                key={f.value}
                size="sm"
                variant={status === f.value ? "primary" : "secondary"}
                onClick={() => setStatus(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        }
      />
      {isLoading ? <p className="text-sm text-muted">Loading…</p> : <AgentTable agents={agents} />}
    </div>
  );
}
