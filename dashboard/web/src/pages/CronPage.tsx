import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { CreateCronDialog } from "@/features/cron/CreateCronDialog";
import { CronTable } from "@/features/cron/CronTable";
import { useCronJobs } from "@/features/cron/useCronJobs";
import { useMemo, useState } from "react";

export function CronPage() {
  const { data, isLoading } = useCronJobs();
  const [dialog, setDialog] = useState(false);
  const grouped = useMemo(() => {
    type Row = typeof data extends { jobs: (infer R)[] } | undefined ? R : never;
    const m = new Map<string, { label: string; jobs: Row[] }>();
    for (const j of (data?.jobs ?? []) as Row[]) {
      const entry = m.get(j.sessionKey);
      if (entry) entry.jobs.push(j);
      else m.set(j.sessionKey, { label: j.sessionLabel, jobs: [j] });
    }
    return [...m.entries()].sort((a, b) => b[1].jobs.length - a[1].jobs.length);
  }, [data]);

  return (
    <div>
      <PageHeader
        title="Cron jobs"
        description="Scheduled system events, self-pokes, retries, and agent-completion deliveries."
        actions={
          <Button variant="primary" onClick={() => setDialog(true)}>
            New cron
          </Button>
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : grouped.length === 0 ? (
        <p className="text-sm text-muted">No active cron jobs across all sessions.</p>
      ) : (
        <div className="space-y-4">
          {grouped.map(([key, { label, jobs }]) => (
            <Card key={key}>
              <CardHeader title={label} subtitle={key} />
              <CardBody className="p-0">
                <CronTable jobs={jobs} showSession={false} />
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <CreateCronDialog open={dialog} onOpenChange={setDialog} />
    </div>
  );
}
