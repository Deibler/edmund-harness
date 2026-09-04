import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { usePeople, useRunMaintainer } from "@/features/people/usePeople";
import { fmtTime, relativeTime } from "@/lib/time";

export function PeoplePage() {
  const { data, isLoading } = usePeople();
  const run = useRunMaintainer();
  return (
    <div>
      <PageHeader
        title="People maintainer"
        description="Haiku pass that keeps persona/people/*.md and persona/groups/*.md current after each reply."
        actions={
          <Button
            variant="primary"
            disabled={run.isPending || data?.kickQueued}
            onClick={() => run.mutate(undefined)}
          >
            {data?.kickQueued ? "Run queued…" : "Force run (all)"}
          </Button>
        }
      />
      {data?.config ? (
        <Card className="mb-4">
          <CardHeader title="Maintainer config" />
          <CardBody className="text-sm grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <span className="text-muted">Enabled: </span>
              {data.config.enabled ? "yes" : "no"}
            </div>
            <div>
              <span className="text-muted">Model: </span>
              <code className="text-xs">{String(data.config.model)}</code>
            </div>
            <div>
              <span className="text-muted">Min interval: </span>
              {data.config.min_interval_minutes}min
            </div>
            <div>
              <span className="text-muted">Recent msgs window: </span>
              {data.config.recent_messages}
            </div>
            <div>
              <span className="text-muted">Dry-run: </span>
              {data.config.dry_run ? <Badge tone="warn">on</Badge> : "off"}
            </div>
            <div className="col-span-2">
              <span className="text-muted">People dir: </span>
              <code className="text-xs">{data.peopleDir}</code>
            </div>
          </CardBody>
        </Card>
      ) : null}
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader title="Sessions by last maintained" />
            <CardBody className="p-0">
              <Table>
                <Thead>
                  <Tr>
                    <Th>Session</Th>
                    <Th>Last inbound</Th>
                    <Th>Last maintained</Th>
                    <Th />
                  </Tr>
                </Thead>
                <tbody>
                  {(data?.sessions ?? []).map((s) => (
                    <Tr key={s.sessionKey}>
                      <Td className="text-xs">{s.label}</Td>
                      <Td className="text-xs text-muted">
                        {s.lastInboundMs ? relativeTime(s.lastInboundMs) : "—"}
                      </Td>
                      <Td className="text-xs">
                        {s.lastMaintainedAtMs ? (
                          <span title={fmtTime(s.lastMaintainedAtMs)}>
                            {relativeTime(s.lastMaintainedAtMs)}
                          </span>
                        ) : (
                          <Badge tone="warn">never</Badge>
                        )}
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={run.isPending}
                          onClick={() => run.mutate(s.sessionKey)}
                        >
                          Run
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="persona/people/*.md files"
              subtitle="Sorted by recency of last write"
            />
            <CardBody className="p-0">
              <Table>
                <Thead>
                  <Tr>
                    <Th>File</Th>
                    <Th>Bytes</Th>
                    <Th>Modified</Th>
                  </Tr>
                </Thead>
                <tbody>
                  {(data?.files ?? []).map((f) => (
                    <Tr key={f.name}>
                      <Td className="font-mono text-xs">{f.name}</Td>
                      <Td className="text-xs">{f.bytes}</Td>
                      <Td className="text-xs text-muted" title={fmtTime(f.mtimeMs)}>
                        {relativeTime(f.mtimeMs)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
