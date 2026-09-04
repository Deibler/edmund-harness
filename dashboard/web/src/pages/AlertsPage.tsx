import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { useAlerts, useMuteAlert, useUnmuteAlert } from "@/features/alerts/useAlerts";
import { fmtTime, relativeTime } from "@/lib/time";
import { useMemo } from "react";

export function AlertsPage() {
  const { data, isLoading } = useAlerts();
  const mute = useMuteAlert();
  const unmute = useUnmuteAlert();
  const alerts = data?.alerts ?? [];
  const mutes = data?.mutes ?? [];
  const muteByCat = useMemo(() => new Map(mutes.map((m) => [m.category, m])), [mutes]);
  const categories = useMemo(() => {
    const s = new Set(alerts.map((a) => a.category));
    return [...s].sort();
  }, [alerts]);
  return (
    <div>
      <PageHeader
        title="Operator alerts"
        description="iMessage alerts the daemon sends when it can't reply normally (auth dead, runner crash, repeated heal failure)."
      />
      <Card className="mb-4">
        <CardHeader
          title="Mutes"
          subtitle="Suppress an alert category for N minutes. Alerts still log but won't iMessage."
        />
        <CardBody className="space-y-2 text-sm">
          {categories.length === 0 ? (
            <p className="text-muted">No alert categories seen yet.</p>
          ) : (
            categories.map((cat) => {
              const m = muteByCat.get(cat);
              const muted = m && m.untilMs > Date.now();
              return (
                <div
                  key={cat}
                  className="flex items-center justify-between gap-2 border-b border-border last:border-0 py-1"
                >
                  <div>
                    <code className="text-xs">{cat}</code>
                    {muted ? (
                      <span className="ml-2 text-xs text-warn">
                        muted until {fmtTime(m!.untilMs)}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    {muted ? (
                      <Button size="sm" variant="secondary" onClick={() => unmute.mutate(cat)}>
                        Unmute
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          onClick={() => mute.mutate({ category: cat, minutes: 60 })}
                        >
                          Mute 1h
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => mute.mutate({ category: cat, minutes: 24 * 60 })}
                        >
                          Mute 24h
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardBody>
      </Card>
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="text-sm text-muted">No alerts recorded.</p>
      ) : (
        <Card>
          <CardHeader title="Recent alerts" subtitle={`${alerts.length} entries`} />
          <CardBody className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Fired</Th>
                  <Th>Category</Th>
                  <Th>Delivered</Th>
                  <Th>Text</Th>
                </Tr>
              </Thead>
              <tbody>
                {alerts.map((a) => (
                  <Tr key={a.id}>
                    <Td
                      className="text-xs text-muted whitespace-nowrap"
                      title={fmtTime(a.firedAtMs)}
                    >
                      {relativeTime(a.firedAtMs)}
                    </Td>
                    <Td className="text-xs">
                      <code>{a.category}</code>
                    </Td>
                    <Td>
                      {a.delivered ? (
                        <Badge tone="ok">sent</Badge>
                      ) : (
                        <Badge tone="warn">muted/failed</Badge>
                      )}
                    </Td>
                    <Td className="text-xs whitespace-pre-wrap max-w-2xl">{a.text}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
