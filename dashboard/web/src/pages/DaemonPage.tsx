import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { useDaemonControl, useDaemonStatus, useSetDebug } from "@/features/daemon/useDaemon";
import { useFlushPool, usePool } from "@/features/pool/usePool";
import { relativeTime } from "@/lib/time";

export function DaemonPage() {
  const { data, isLoading } = useDaemonStatus();
  const control = useDaemonControl();
  const debug = useSetDebug();
  const toast = useToast();
  const status = data?.status;

  async function fire(cmd: "start" | "stop" | "restart") {
    try {
      const r = await control.mutateAsync(cmd);
      toast.push({
        tone: r.ok ? "ok" : "danger",
        title: `${cmd}: ${r.ok ? "ok" : "failed"}`,
        description: r.output,
      });
    } catch (e) {
      toast.push({ tone: "danger", title: "failed", description: (e as Error).message });
    }
  }

  return (
    <div>
      <PageHeader
        title="Daemon"
        description="launchctl-managed iMessage pipeline. Reads chat.db, runs claude, delivers replies."
      />
      {isLoading || !status ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="Status" />
            <CardBody className="space-y-2 text-sm">
              <Row label="Loaded">
                <Badge tone={status.loaded ? "ok" : "danger"}>{status.loaded ? "yes" : "no"}</Badge>
              </Row>
              <Row label="Running">
                <Badge tone={status.running ? "ok" : "warn"}>{status.running ? "yes" : "no"}</Badge>
              </Row>
              <Row label="PID">
                <span className="font-mono">{status.pid ?? "—"}</span>
              </Row>
              <Row label="Last exit">
                <span className="font-mono">{status.lastExitCode ?? "—"}</span>
              </Row>
              <Row label="Debug logging">
                <Badge tone={status.debug === "on" ? "accent" : "neutral"}>{status.debug}</Badge>
              </Row>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Controls" subtitle="Shells out to scripts/launchd/service.sh" />
            <CardBody className="space-y-3">
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => fire("start")}
                  disabled={control.isPending}
                >
                  Start
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => fire("restart")}
                  disabled={control.isPending}
                >
                  Restart
                </Button>
                <Button variant="danger" onClick={() => fire("stop")} disabled={control.isPending}>
                  Stop
                </Button>
              </div>
              <div className="flex gap-2 pt-2 border-t border-border">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => debug.mutate("on")}
                  disabled={debug.isPending}
                >
                  Debug on
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => debug.mutate("off")}
                  disabled={debug.isPending}
                >
                  Debug off
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card className="md:col-span-2">
            <ResourcePanel />
          </Card>

          <Card className="md:col-span-2">
            <ClaudePoolPanel />
          </Card>

          <Card className="md:col-span-2">
            <CardHeader title="Raw launchctl output" />
            <CardBody>
              <pre className="text-xs font-mono text-muted whitespace-pre-wrap">
                {status.raw || "(empty)"}
              </pre>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function mib(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024).toLocaleString()} MiB`;
}

function ResourcePanel() {
  const { data } = usePool();
  const s = data?.resources;
  const tone = s?.pressure === "hard" ? "danger" : s?.pressure === "soft" ? "warn" : "ok";
  return (
    <>
      <CardHeader
        title="Memory governor"
        subtitle="Managed daemon and detached worker process groups only; unrelated user processes are excluded."
      />
      <CardBody>
        {!s ? (
          <p className="text-sm text-muted">Waiting for the daemon's first memory sample…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div>
                <div className="text-xs text-muted">Pressure</div>
                <Badge tone={tone}>{s.pressure}</Badge>
              </div>
              <div>
                <div className="text-xs text-muted">Managed RSS</div>
                <div className="text-xl font-semibold">{mib(s.managed.rssBytes)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Daemon RSS</div>
                <div className="text-xl font-semibold">{mib(s.daemon.rssBytes)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Soft / hard</div>
                <div>
                  {mib(s.limits.softBytes)} / {mib(s.limits.hardBytes)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Processes</div>
                <div>{s.managed.processCount}</div>
              </div>
            </div>
            <div className="text-xs text-muted">
              Snapshot {relativeTime(s.timestampMs)}
              {s.busy ? " · active turn protected" : " · idle cleanup allowed"}
              {s.managed.largest
                ? ` · largest ${s.managed.largest.command} ${mib(s.managed.largest.rssBytes)}`
                : ""}
            </div>
            {s.action ? <div className="rounded bg-muted/20 p-2 text-xs">{s.action}</div> : null}
          </div>
        )}
      </CardBody>
    </>
  );
}

function ClaudePoolPanel() {
  const { data } = usePool();
  const flush = useFlushPool();
  const s = data?.stats;
  const cfg = data?.config;
  const total = (s?.hits ?? 0) + (s?.misses ?? 0);
  const hitPct = total > 0 ? Math.round(((s?.hits ?? 0) / total) * 100) : null;
  return (
    <>
      <CardHeader
        title="Claude worker pool"
        subtitle="Resident `claude -p` workers reused across turns. Counters reset every 10 min by the pool's internal logger."
        right={
          <Button
            size="sm"
            variant="danger"
            disabled={flush.isPending}
            onClick={() => flush.mutate()}
          >
            Flush all
          </Button>
        }
      />
      <CardBody className="space-y-3">
        {!cfg?.enabled ? (
          <Badge tone="neutral">
            Pool disabled in config — daemon spawns fresh `claude` per turn.
          </Badge>
        ) : !s ? (
          <p className="text-sm text-muted">
            No stats yet — daemon writes pool-stats.json every 5s when the pool has workers.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted">Workers</div>
                <div className="text-xl font-semibold">
                  {s.poolSize} / {s.maxWorkers}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Hit rate</div>
                <div className="text-xl font-semibold">{hitPct === null ? "—" : `${hitPct}%`}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Hits / misses</div>
                <div className="text-xl font-semibold">
                  {s.hits} / {s.misses}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Dead discards</div>
                <div className="text-xl font-semibold">{s.deadDiscards}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Rebinds</div>
                <div>{s.rebinds}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Idle evictions</div>
                <div>{s.idleEvictions}</div>
              </div>
              <div>
                <div className="text-xs text-muted">LRU evictions</div>
                <div>{s.lruEvictions}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Snapshot</div>
                <div>{relativeTime(s.windowStartMs)}</div>
              </div>
            </div>
            {s.workers.length ? (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Session</Th>
                    <Th>Rebind key</Th>
                    <Th>PID</Th>
                    <Th>Last used</Th>
                    <Th>Dead?</Th>
                  </Tr>
                </Thead>
                <tbody>
                  {s.workers.map((w) => (
                    <Tr key={w.sessionKey}>
                      <Td className="text-xs">{w.sessionKey}</Td>
                      <Td className="font-mono text-xs">{w.rebindKey}</Td>
                      <Td className="text-xs">{w.pid ?? "—"}</Td>
                      <Td className="text-xs">{relativeTime(w.lastUsedMs)}</Td>
                      <Td>
                        {w.isDead ? (
                          <Badge tone="danger">dead</Badge>
                        ) : (
                          <Badge tone="ok">live</Badge>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {s.deaths.length ? (
              <div>
                <div className="text-xs text-muted mb-1">
                  Death reasons (since last 10-min flush)
                </div>
                <ul className="text-xs space-y-0.5">
                  {s.deaths.map((d) => (
                    <li key={d.reason}>
                      <code>{d.n}×</code> {d.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <div>{children}</div>
    </div>
  );
}
