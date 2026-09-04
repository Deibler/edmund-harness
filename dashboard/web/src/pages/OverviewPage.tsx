import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { useOverview } from "@/features/activity/useOverview";
import { useMetrics } from "@/features/metrics/useMetrics";
import { fmtTime, relativeTime } from "@/lib/time";
import type { ActivityEvent } from "@api/types";
import { Link } from "react-router-dom";

export function OverviewPage() {
  const { data, isLoading } = useOverview();
  return (
    <div>
      <PageHeader title="Overview" description="Daemon health and recent activity at a glance." />
      {isLoading || !data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
            <StatCard
              label="Daemon"
              value={data.daemon.running ? "running" : data.daemon.loaded ? "loaded" : "down"}
              tone={data.daemon.running ? "ok" : "danger"}
              sub={data.daemon.pid ? `pid ${data.daemon.pid}` : undefined}
            />
            <StatCard
              label="Sessions"
              value={String(data.sessions.total)}
              sub={`${data.sessions.dms} DMs · ${data.sessions.groups} groups`}
            />
            <StatCard
              label="Active agents"
              value={String(data.agents.active)}
              tone={data.agents.stuck ? "warn" : "neutral"}
              sub={
                data.agents.stuck ? `${data.agents.stuck} stuck` : `${data.agents.last24h} today`
              }
            />
            <StatCard
              label="Active cron"
              value={String(data.crons.active)}
              sub={
                data.crons.nextDueMs ? `next ${relativeTime(data.crons.nextDueMs)}` : "no upcoming"
              }
            />
            <StatCard
              label="Errors (1h)"
              value={String(data.errorsLastHour)}
              tone={data.errorsLastHour > 0 ? "danger" : "ok"}
            />
          </div>
          <Card>
            <CardHeader
              title="Recent activity"
              subtitle="Inbound, outbound, agents, and cron fires"
            />
            <CardBody className="p-0">
              <ul className="divide-y divide-border">
                {data.recent.length === 0 ? (
                  <li className="p-4 text-sm text-muted">Nothing yet.</li>
                ) : (
                  data.recent.map((ev, i) => (
                    <li
                      key={`${ev.kind}-${ev.ts}-${i}`}
                      className="p-3 text-sm flex items-center gap-3"
                    >
                      <EventBadge event={ev} />
                      <Link
                        to={`/sessions/${encodeURIComponent("sessionKey" in ev ? ev.sessionKey : "")}`}
                        className="text-fg hover:text-accent"
                      >
                        {"sessionLabel" in ev ? ev.sessionLabel : ""}
                      </Link>
                      <span className="text-muted flex-1 truncate">{describe(ev)}</span>
                      <span className="text-xs text-muted whitespace-nowrap">{fmtTime(ev.ts)}</span>
                    </li>
                  ))
                )}
              </ul>
            </CardBody>
          </Card>
          <SpendPanel />
        </div>
      )}
    </div>
  );
}

/** Model-spend trends from data/spend.db (Phase-3 economics substrate).
 *  Rows appear as subsystems record — a fresh deploy starts empty. */
function SpendPanel() {
  const { data } = useMetrics(14);
  if (!data || data.byDay.length === 0) return null;
  const maxCost = Math.max(...data.byDay.map((d) => d.costUsd), 0.01);
  const totalCost = data.byDay.reduce((a, d) => a + d.costUsd, 0);
  const totalTurns = data.byDay.reduce((a, d) => a + d.turns, 0);
  return (
    <Card>
      <CardHeader
        title="Model spend (14d)"
        subtitle={`$${totalCost.toFixed(2)} across ${totalTurns} invocations`}
      />
      <CardBody>
        <div className="flex items-end gap-1 h-24 mb-4">
          {data.byDay.map((d) => (
            <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              <div
                className="w-full bg-accent/70 rounded-sm"
                style={{ height: `${Math.max(2, (d.costUsd / maxCost) * 100)}%` }}
                title={`${d.day}: $${d.costUsd.toFixed(2)} · ${d.turns} calls`}
              />
              <div className="text-[9px] text-muted truncate">{d.day.slice(5)}</div>
            </div>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <div className="text-xs text-muted mb-1">By subsystem</div>
            <ul className="text-sm space-y-0.5">
              {data.bySubsystem.slice(0, 6).map((s) => (
                <li key={s.subsystem} className="flex justify-between gap-2">
                  <span className="truncate">{s.subsystem}</span>
                  <span className="text-muted whitespace-nowrap">
                    ${s.costUsd.toFixed(2)} · {s.turns}× ·{" "}
                    {s.turns > 0 ? `${Math.round(s.durMs / s.turns / 1000)}s avg` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Top sessions</div>
            <ul className="text-sm space-y-0.5">
              {data.bySession.slice(0, 6).map((s) => (
                <li key={s.sessionKey} className="flex justify-between gap-2">
                  <Link
                    to={`/sessions/${encodeURIComponent(s.sessionKey)}`}
                    className="truncate hover:text-accent"
                  >
                    {s.sessionKey}
                  </Link>
                  <span className="text-muted whitespace-nowrap">
                    ${s.costUsd.toFixed(2)} · {s.turns}×
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "danger" | "neutral";
}) {
  const toneClass = {
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    neutral: "text-fg",
  }[tone];
  return (
    <Card>
      <CardBody>
        <div className="text-xs text-muted">{label}</div>
        <div className={`text-2xl font-semibold mt-1 ${toneClass}`}>{value}</div>
        {sub ? <div className="text-xs text-muted mt-1">{sub}</div> : null}
      </CardBody>
    </Card>
  );
}

function EventBadge({ event }: { event: ActivityEvent }) {
  switch (event.kind) {
    case "inbound":
      return <Badge tone="accent">inbound</Badge>;
    case "outbound":
      return <Badge tone="ok">outbound</Badge>;
    case "agent":
      return (
        <Badge
          tone={event.status === "failed" ? "danger" : event.status === "done" ? "ok" : "accent"}
        >
          agent {event.status}
        </Badge>
      );
    case "cron":
      return <Badge tone="neutral">cron</Badge>;
    case "error":
      return <Badge tone="danger">error</Badge>;
  }
}

function describe(ev: ActivityEvent): string {
  switch (ev.kind) {
    case "inbound":
      return "last inbound";
    case "outbound":
      return "last outbound";
    case "agent":
      return ev.taskPreview;
    case "cron":
      return ev.summary;
    case "error":
      return ev.text;
  }
}
