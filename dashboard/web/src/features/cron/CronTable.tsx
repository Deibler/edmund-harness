import { Button } from "@/components/ui/Button";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { KindBadge } from "@/features/cron/ScheduleBadge";
import { fmtTime, relativeTime } from "@/lib/time";
import type { CronJobDto } from "@api/types";
import { Link } from "react-router-dom";
import { useCancelCron } from "./useCronJobs";

export function CronTable({
  jobs,
  showSession = true,
}: { jobs: CronJobDto[]; showSession?: boolean }) {
  const cancel = useCancelCron();
  if (jobs.length === 0) {
    return <p className="text-sm text-muted">No active cron jobs.</p>;
  }
  return (
    <Table>
      <Thead>
        <Tr>
          {showSession ? <Th>Session</Th> : null}
          <Th>Kind</Th>
          <Th>Event</Th>
          <Th>Schedule</Th>
          <Th>Next</Th>
          <Th />
        </Tr>
      </Thead>
      <tbody>
        {jobs.map((j) => (
          <Tr key={j.id}>
            {showSession ? (
              <Td>
                <Link
                  to={`/sessions/${encodeURIComponent(j.sessionKey)}`}
                  className="text-fg hover:text-accent"
                >
                  {j.sessionLabel}
                </Link>
              </Td>
            ) : null}
            <Td>
              <KindBadge kind={j.kind} />
            </Td>
            <Td className="max-w-[30rem] truncate" title={j.systemEvent}>
              <span className="text-muted">{j.systemEvent.slice(0, 120)}</span>
            </Td>
            <Td className="text-xs text-muted font-mono">{j.scheduleSummary}</Td>
            <Td className="text-muted whitespace-nowrap">
              {fmtTime(j.nextFireMs)}{" "}
              <span className="text-xs">({relativeTime(j.nextFireMs)})</span>
            </Td>
            <Td>
              <Button
                size="sm"
                variant="danger"
                onClick={() => cancel.mutate(j.id)}
                disabled={cancel.isPending}
              >
                Cancel
              </Button>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
