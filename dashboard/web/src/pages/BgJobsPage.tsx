import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { useBgJob, useBgJobs } from "@/features/bgjobs/useBgJobs";
import { humanMs, relativeTime } from "@/lib/time";
import type { BgJobDto } from "@api/types";
import { useEffect, useMemo, useState } from "react";

const STATUS_FILTERS: Array<{ label: string; value: BgJobDto["status"] | "all" }> = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Running", value: "running" },
  { label: "Done", value: "done" },
  { label: "Failed", value: "failed" },
];

const statusTone: Record<BgJobDto["status"], "neutral" | "ok" | "warn" | "danger" | "accent"> = {
  pending: "neutral",
  running: "accent",
  done: "ok",
  failed: "danger",
};

export function BgJobsPage() {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]["value"]>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useBgJobs(status === "all" ? undefined : { status });
  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  return (
    <div>
      <PageHeader
        title="Background jobs"
        description="Async tool calls (`async: true` MCP runs). Detached subprocess writes a result file then fires a wake-up cron."
        actions={
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
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
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted">No background jobs.</p>
      ) : (
        <Card>
          <CardBody className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Status</Th>
                  <Th>Tool</Th>
                  <Th>Session</Th>
                  <Th>Created</Th>
                  <Th>Duration</Th>
                  <Th>Wake</Th>
                  <Th />
                </Tr>
              </Thead>
              <tbody>
                {jobs.map((j) => {
                  const dur =
                    j.finishedAt && j.startedAt
                      ? humanMs(j.finishedAt - j.startedAt)
                      : j.startedAt
                        ? `${humanMs(Date.now() - j.startedAt)}…`
                        : "—";
                  return (
                    <Tr key={j.id}>
                      <Td>
                        <Badge tone={statusTone[j.status]}>{j.status}</Badge>
                      </Td>
                      <Td className="font-mono text-xs">{j.toolName}</Td>
                      <Td className="text-xs">{j.label}</Td>
                      <Td className="text-xs text-muted">{relativeTime(j.createdAt)}</Td>
                      <Td className="text-xs">{dur}</Td>
                      <Td className="text-xs">
                        {j.wakeFiredAt ? (
                          <Badge tone="ok">fired</Badge>
                        ) : j.status === "done" || j.status === "failed" ? (
                          <Badge tone="warn">missing</Badge>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td>
                        <Button size="sm" variant="ghost" onClick={() => setSelected(j.id)}>
                          Details
                        </Button>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
      {selected ? <BgJobDetail id={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function BgJobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useBgJob(id);
  const j = data?.job;

  // Escape closes the dialog. Backdrop click alone left keyboard-only users with
  // no way out — the Close button is reachable, but Escape is what people press.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // The backdrop is a mouse convenience, not the only way to dismiss: Escape
    // (above) and the Close button are the keyboard paths, so the backdrop
    // itself is presentational.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape handler above is the keyboard equivalent
    <div
      role="presentation"
      className="fixed inset-0 z-30 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop dismissal; not an interactive control */}
      <div
        role="presentation"
        className="bg-bg border border-border rounded-xl max-w-3xl w-full max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader
          title={`Job ${id}`}
          subtitle={j?.toolName}
          right={
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          }
        />
        <CardBody className="space-y-3 text-sm">
          {!j ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-muted">Status: </span>
                  <Badge tone={statusTone[j.status]}>{j.status}</Badge>
                </div>
                <div>
                  <span className="text-muted">PID: </span>
                  {j.pid ?? "—"}
                </div>
                <div>
                  <span className="text-muted">Session: </span>
                  {j.label}
                </div>
                <div>
                  <span className="text-muted">Created: </span>
                  {relativeTime(j.createdAt)}
                </div>
                <div>
                  <span className="text-muted">Started: </span>
                  {j.startedAt ? relativeTime(j.startedAt) : "—"}
                </div>
                <div>
                  <span className="text-muted">Finished: </span>
                  {j.finishedAt ? relativeTime(j.finishedAt) : "—"}
                </div>
                <div className="col-span-2">
                  <span className="text-muted">Sandbox: </span>
                  <code className="font-mono text-xs">{j.sandboxPath}</code>
                </div>
                {j.resultPath ? (
                  <div className="col-span-2">
                    <span className="text-muted">Result: </span>
                    <code className="font-mono text-xs">{j.resultPath}</code>
                  </div>
                ) : null}
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Args</div>
                <pre className="bg-card border border-border rounded p-2 text-xs overflow-auto max-h-40">
                  {tryPretty(j.argsJson)}
                </pre>
              </div>
              {j.resultSummary ? (
                <div>
                  <div className="text-xs text-muted mb-1">Result summary</div>
                  <pre className="bg-card border border-border rounded p-2 text-xs whitespace-pre-wrap">
                    {j.resultSummary}
                  </pre>
                </div>
              ) : null}
              {j.errorText ? (
                <div>
                  <div className="text-xs text-danger mb-1">Error</div>
                  <pre className="bg-danger/5 border border-danger/30 rounded p-2 text-xs whitespace-pre-wrap">
                    {j.errorText}
                  </pre>
                </div>
              ) : null}
            </>
          )}
        </CardBody>
      </div>
    </div>
  );
}

function tryPretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
