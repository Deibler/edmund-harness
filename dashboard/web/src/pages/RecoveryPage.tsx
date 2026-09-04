import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { useRecovery, useRecoveryReset, useRecoverySweep } from "@/features/recovery/useRecovery";
import { fmtTime, relativeTime } from "@/lib/time";

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function RecoveryPage() {
  const { data, isLoading } = useRecovery();
  const sweep = useRecoverySweep();
  const reset = useRecoveryReset();
  const rows = data?.rows ?? [];
  const cfg = data?.config;
  return (
    <div>
      <PageHeader
        title="Recovery sweeper"
        description="Background sweep finds sessions where the user spoke but the bot never replied (crash, bridge wedge) and re-attempts."
        actions={
          <Button
            variant="primary"
            disabled={sweep.isPending || data?.sweepKicked}
            onClick={() => sweep.mutate()}
          >
            {data?.sweepKicked ? "Sweep queued…" : "Force sweep"}
          </Button>
        }
      />
      {cfg ? (
        <Card className="mb-4">
          <CardHeader title="Sweeper config" />
          <CardBody className="text-sm grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <span className="text-muted">Enabled: </span>
              {cfg.enabled ? "yes" : "no"}
            </div>
            <div>
              <span className="text-muted">Interval: </span>
              {cfg.sweep_interval_seconds}s
            </div>
            <div>
              <span className="text-muted">Stale: </span>
              {cfg.stale_threshold_seconds}s
            </div>
            <div>
              <span className="text-muted">Cooldown: </span>
              {cfg.cooldown_minutes}min
            </div>
            <div>
              <span className="text-muted">Max heal failures: </span>
              {cfg.max_heal_failures_before_alert}
            </div>
            <div>
              <span className="text-muted">Max age alert: </span>
              {cfg.max_age_hours}h
            </div>
          </CardBody>
        </Card>
      ) : null}
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No sessions currently look stuck.</p>
      ) : (
        <Card>
          <CardHeader title={`Stuck sessions (${rows.length})`} />
          <CardBody className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Session</Th>
                  <Th>Last inbound</Th>
                  <Th>Stuck</Th>
                  <Th>Failures</Th>
                  <Th>Cooldown</Th>
                  <Th>Last error</Th>
                  <Th />
                </Tr>
              </Thead>
              <tbody>
                {rows.map((r) => {
                  const now = Date.now();
                  const cooldown = r.cooldownUntilMs && r.cooldownUntilMs > now;
                  return (
                    <Tr key={r.sessionKey}>
                      <Td className="text-xs">{r.label}</Td>
                      <Td className="text-xs text-muted">
                        {r.lastInboundMs ? relativeTime(r.lastInboundMs) : "—"}
                      </Td>
                      <Td className="text-xs">{fmtDur(r.stuckSeconds)}</Td>
                      <Td>
                        <Badge
                          tone={
                            r.healFailures >= 3 ? "danger" : r.healFailures > 0 ? "warn" : "neutral"
                          }
                        >
                          {r.healFailures}
                        </Badge>
                      </Td>
                      <Td className="text-xs">
                        {cooldown ? (
                          <span className="text-warn" title={fmtTime(r.cooldownUntilMs!)}>
                            {fmtDur(Math.round((r.cooldownUntilMs! - now) / 1000))}
                          </span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td
                        className="text-xs text-muted max-w-md truncate"
                        title={r.lastErrorText ?? ""}
                      >
                        {r.lastErrorText ?? "—"}
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reset.isPending}
                          onClick={() => reset.mutate(r.sessionKey)}
                        >
                          Reset cooldown
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
    </div>
  );
}
