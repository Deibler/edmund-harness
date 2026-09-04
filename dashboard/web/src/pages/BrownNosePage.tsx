import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import {
  type BrownNoseRow,
  type InvokeResult,
  useBrownNoseList,
  useDisable,
  useEnable,
  useInvoke,
} from "@/features/brownnose/useBrownNose";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

/** Session list — click any row for the nested per-chat control page
 *  (/brownnose/:key) with queued fires, allowed hours, and full history. */
export function BrownNosePage() {
  const { data, isLoading } = useBrownNoseList();
  const navigate = useNavigate();
  const enable = useEnable();
  const disable = useDisable();
  const invoke = useInvoke();
  const [invokeResult, setInvokeResult] = useState<InvokeResult | null>(null);
  const [invokingKey, setInvokingKey] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const rows = data?.sessions ?? [];
    // Active enabled first, then disabled, then not-enrolled. Within each
    // group, most-recent user activity first.
    const rank = (r: BrownNoseRow) => (!r.enrolled ? 2 : r.enabled ? 0 : 1);
    return [...rows].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return (b.lastInboundMs ?? 0) - (a.lastInboundMs ?? 0);
    });
  }, [data]);

  const openDetail = (sessionKey: string) =>
    navigate(`/brownnose/${encodeURIComponent(sessionKey)}`);

  const runInvoke = (sessionKey: string) => {
    setInvokeResult(null);
    setInvokingKey(sessionKey);
    invoke.mutate(
      { sessionKey, fireNow: false },
      {
        onSuccess: (res) => setInvokeResult(res),
        onSettled: () => setInvokingKey(null),
      },
    );
  };

  return (
    <div>
      <PageHeader
        title="Brown nose"
        description="Per-session proactive outreach. Click a chat for its control page: queued fires, allowed hours, decisions, everything."
      />

      {data?.globals ? (
        <Card className="mb-4">
          <CardHeader title="Globals" />
          <CardBody className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Field label="enabled" value={String(data.globals.enabled)} />
            <Field label="intensity" value={String(data.globals.intensity)} />
            <Field
              label="effective"
              value={`${data.globals.intensityParams.cooldownHours}h cd · ${data.globals.intensityParams.weeklyCap}/wk`}
            />
            <Field label="max concurrent fires" value={String(data.globals.maxConcurrentFires)} />
          </CardBody>
        </Card>
      ) : null}

      {data?.budget ? (
        <Card className="mb-4">
          <CardHeader title="Budget" subtitle="Fires across all enrolled sessions" />
          <CardBody className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <Field label="enrolled" value={String(data.budget.enrolledCount)} />
            <Field label="enabled" value={String(data.budget.enabledCount)} />
            <Field label="fires today" value={String(data.budget.firesToday)} />
            <Field label="fires this week" value={String(data.budget.firesThisWeek)} />
            <Field label="max ticks/chat/day" value={String(data.budget.maxGhostTicksPerDay)} />
          </CardBody>
        </Card>
      ) : null}

      {invokingKey ? (
        <Card className="mb-4 border-accent">
          <CardBody className="text-sm">
            ghost is working on <span className="font-medium">{invokingKey}</span> — researching +
            deciding, this can take a few minutes…
          </CardBody>
        </Card>
      ) : null}
      {invokeResult ? (
        <Card className="mb-4">
          <CardHeader
            title="Forced tick result"
            right={
              <Button variant="secondary" size="sm" onClick={() => setInvokeResult(null)}>
                dismiss
              </Button>
            }
          />
          <CardBody className="text-sm space-y-2">
            {invokeResult.decision.act ? (
              <>
                <div>
                  <Badge tone="ok">ACT</Badge>{" "}
                  <span className="text-muted">
                    confidence {invokeResult.decision.confidence} ·{" "}
                    {(invokeResult.decision.tags ?? []).join(", ")}
                  </span>
                </div>
                <div className="text-fg whitespace-pre-wrap">{invokeResult.decision.brief}</div>
                {invokeResult.enqueue ? (
                  invokeResult.enqueue.enqueued ? (
                    <div className="text-xs text-ok">
                      queued {invokeResult.enqueue.jobId} — fires{" "}
                      {invokeResult.enqueue.jitteredFireAtMs
                        ? new Date(invokeResult.enqueue.jitteredFireAtMs).toLocaleString()
                        : "soon"}
                    </div>
                  ) : (
                    <div className="text-xs text-danger">
                      enqueue failed: {invokeResult.enqueue.reason}
                    </div>
                  )
                ) : null}
              </>
            ) : (
              <>
                <div>
                  <Badge tone="neutral">NO</Badge>
                  {invokeResult.decision.snoozeUntilMs ? (
                    <span className="ml-2 text-xs text-muted">
                      snoozed until {new Date(invokeResult.decision.snoozeUntilMs).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                <div className="text-muted">{invokeResult.decision.reason}</div>
              </>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Sessions" />
        <CardBody className="p-0">
          {isLoading ? (
            <div className="p-4 text-sm text-muted">loading…</div>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>who</Th>
                  <Th>kind</Th>
                  <Th>state</Th>
                  <Th>hours</Th>
                  <Th>last msg</Th>
                  <Th>last fire</Th>
                  <Th>actions</Th>
                </Tr>
              </Thead>
              <tbody>
                {sorted.map((r) => (
                  <Tr
                    key={r.sessionKey}
                    className="cursor-pointer hover:bg-card/60"
                    onClick={() => openDetail(r.sessionKey)}
                  >
                    <Td>
                      <div className="font-medium">{r.label}</div>
                      {r.isGroup && r.members.length > 0 ? (
                        <div className="text-xs text-muted max-w-[28rem] truncate">
                          {r.members.join(", ")}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={r.isGroup ? "accent" : "neutral"}>
                        {r.isGroup ? "group" : "dm"}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        {renderState(r)}
                        {r.snoozedUntilMs ? <Badge tone="accent">snoozed</Badge> : null}
                      </div>
                    </Td>
                    <Td className="text-xs text-muted">{summarizeHours(r.activeHours)}</Td>
                    <Td className="text-xs text-muted">
                      {r.lastInboundMs ? relAgo(r.lastInboundMs) : "—"}
                    </Td>
                    <Td className="text-xs text-muted">
                      {r.lastFireAtMs
                        ? `${relAgo(r.lastFireAtMs)} (${r.lastFireOutcome ?? "pending"})`
                        : "—"}
                    </Td>
                    <Td onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">
                        {r.enrolled && r.enabled ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              disable.mutate({ sessionKey: r.sessionKey, reason: "dashboard" })
                            }
                          >
                            disable
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => enable.mutate(r.sessionKey)}
                          >
                            enable
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={invokingKey !== null}
                          onClick={() => runInvoke(r.sessionKey)}
                          title="Run a real ghost tick now (bypasses budgets; fires if it finds a hook)"
                        >
                          {invokingKey === r.sessionKey ? "working…" : "tick now"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openDetail(r.sessionKey)}
                        >
                          manage
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function renderState(r: BrownNoseRow) {
  if (!r.enrolled) return <Badge tone="neutral">not enrolled</Badge>;
  if (!r.enabled) return <Badge tone="warn">off</Badge>;
  return <Badge tone="ok">on</Badge>;
}

/** Compact hours summary: "daily 10:00–23:00", "7 windows", or "never". */
function summarizeHours(hours: Array<{ dow: string; start: string; end: string }>): string {
  if (hours.length === 0) return "never";
  const first = hours[0]!;
  if (hours.length === 7 && hours.every((w) => w.start === first.start && w.end === first.end)) {
    return `daily ${first.start}–${first.end}`;
  }
  return `${hours.length} window${hours.length === 1 ? "" : "s"}`;
}

function relAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}
