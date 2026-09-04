import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import {
  type InvokeResult,
  type QueuedFire,
  type StoredDecision,
  useBrownNoseDetail,
  useCancelQueued,
  useClearSnooze,
  useDisable,
  useEnable,
  useInvoke,
  useRescheduleQueued,
  useReset,
  useSetHours,
} from "@/features/brownnose/useBrownNose";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

const DOWS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Dow = (typeof DOWS)[number];
type DayRow = { on: boolean; start: string; end: string };
type HoursState = Record<Dow, DayRow>;

/** Nested operator page for ONE chat's proactive ghost: full control over
 *  state, queued fires (delete / move), allowed hours, plus the verbose
 *  history (fires, decisions, workspace). Reached by clicking a row on
 *  /brownnose. */
export function BrownNoseDetailPage() {
  const { key: encodedKey } = useParams<{ key: string }>();
  const sessionKey = encodedKey ? decodeURIComponent(encodedKey) : null;
  const navigate = useNavigate();
  const detail = useBrownNoseDetail(sessionKey);
  const enable = useEnable();
  const disable = useDisable();
  const reset = useReset();
  const clearSnooze = useClearSnooze();
  const invoke = useInvoke();
  const [invokeResult, setInvokeResult] = useState<InvokeResult | null>(null);
  const [invoking, setInvoking] = useState(false);

  const d = detail.data;

  const runInvoke = (fireNow: boolean) => {
    if (!sessionKey) return;
    setInvokeResult(null);
    setInvoking(true);
    invoke.mutate(
      { sessionKey, fireNow },
      {
        onSuccess: (res) => setInvokeResult(res),
        onSettled: () => setInvoking(false),
      },
    );
  };

  if (!sessionKey) return <div className="text-sm text-muted">no session key</div>;

  return (
    <div>
      <PageHeader
        title={d?.label ?? sessionKey}
        description={
          d
            ? d.isGroup && d.members.length > 0
              ? `group · ${d.members.join(", ")}`
              : `dm · ${d.handle}`
            : ""
        }
        actions={
          <Link to="/brownnose" className="text-sm text-muted hover:text-fg">
            ← all sessions
          </Link>
        }
      />

      {!d ? (
        <div className="text-sm text-muted">loading…</div>
      ) : (
        <div className="space-y-4">
          {/* ── state + actions ── */}
          <Card>
            <CardHeader
              title="State"
              right={
                <div className="flex gap-2">
                  {d.prefs?.enabled ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => disable.mutate({ sessionKey, reason: "dashboard" })}
                    >
                      disable
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => enable.mutate(sessionKey)}>
                      enable
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={invoking}
                    title="Run a real ghost tick now (bypasses budgets)"
                    onClick={() => runInvoke(false)}
                  >
                    {invoking ? "working…" : "tick now"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={invoking}
                    title="Tick now and, if it acts, queue the fire with no jitter"
                    onClick={() => runInvoke(true)}
                  >
                    tick + fire asap
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (confirm("Drop brown_nose_prefs for this session?")) {
                        reset.mutate(sessionKey);
                        navigate("/brownnose");
                      }
                    }}
                  >
                    reset
                  </Button>
                </div>
              }
            />
            <CardBody className="space-y-3 text-sm">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field
                  label="state"
                  value={
                    !d.prefs ? (
                      <Badge tone="neutral">not enrolled</Badge>
                    ) : d.prefs.enabled ? (
                      <Badge tone="ok">on</Badge>
                    ) : (
                      <Badge tone="warn">off</Badge>
                    )
                  }
                />
                <Field label="timezone" value={d.prefs?.timezone ?? "—"} />
                <Field label="weekly cap" value={String(d.prefs?.weeklyCap ?? "—")} />
                <Field
                  label="cooldown ×"
                  value={d.prefs ? `×${d.prefs.cooldownMultiplier.toFixed(1)}` : "—"}
                />
                <Field
                  label="last inbound"
                  value={d.lastInboundMs ? relAgo(d.lastInboundMs) : "never"}
                />
                <Field
                  label="last outbound"
                  value={d.lastOutboundMs ? relAgo(d.lastOutboundMs) : "never"}
                />
                <Field label="focus topics" value={String(d.prefs?.focusSuggestions.length ?? 0)} />
                <Field label="decisions logged" value={String(d.stats.decisionsTotal)} />
              </div>
              {d.prefs && !d.prefs.enabled && d.prefs.disabledReason ? (
                <div className="text-xs text-warn">disabled: {d.prefs.disabledReason}</div>
              ) : null}
              {d.prefs?.snoozeActive ? (
                <div className="flex items-center gap-2 text-xs">
                  <Badge tone="accent">snoozed</Badge>
                  <span className="text-muted">
                    until {new Date(d.prefs.snoozeUntilMs!).toLocaleString()} (any new inbound voids
                    it)
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => clearSnooze.mutate(sessionKey)}
                  >
                    clear snooze
                  </Button>
                </div>
              ) : null}
            </CardBody>
          </Card>

          {invoking ? (
            <Card className="border-accent">
              <CardBody className="text-sm">
                ghost is working — researching + deciding, this can take a few minutes…
              </CardBody>
            </Card>
          ) : null}
          {invokeResult ? (
            <InvokeResultCard result={invokeResult} onDismiss={() => setInvokeResult(null)} />
          ) : null}

          {/* ── queued fires ── */}
          <QueuedFiresCard sessionKey={sessionKey} queued={d.queued} />

          {/* ── allowed hours ── */}
          <HoursCard
            sessionKey={sessionKey}
            timezone={d.prefs?.timezone ?? "America/New_York"}
            activeHours={d.prefs?.activeHours ?? []}
          />

          {/* ── stats ── */}
          <Card>
            <CardHeader title="Stats" subtitle={`last ${d.stats.decisionsTotal} decisions`} />
            <CardBody className="grid grid-cols-3 md:grid-cols-6 gap-3 text-sm">
              <Field label="acts" value={String(d.stats.acts)} />
              <Field label="model NOs" value={String(d.stats.modelNos)} />
              <Field label="gate NOs (free)" value={String(d.stats.gateNos)} />
              <Field label="snoozes set" value={String(d.stats.snoozesSet)} />
              <Field label="parse errors" value={String(d.stats.parseErrors)} />
              <Field
                label="fire outcomes"
                value={
                  Object.entries(d.stats.firesByOutcome)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${k} ${n}`)
                    .join(" · ") || "—"
                }
              />
            </CardBody>
          </Card>

          {/* ── workspace ── */}
          {d.workspace.currentNotes || d.workspace.files.length > 0 ? (
            <Card>
              <CardHeader title="Ghost workspace" />
              <CardBody className="text-sm">
                {d.workspace.currentNotes ? (
                  <pre className="text-xs bg-card/60 rounded p-2 whitespace-pre-wrap max-h-64 overflow-auto">
                    {d.workspace.currentNotes}
                  </pre>
                ) : null}
                {d.workspace.files.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {d.workspace.files.map((f) => (
                      <div key={f.path} className="text-xs text-muted">
                        {f.rel} · {(f.sizeBytes / 1024).toFixed(1)}kb · {relAgo(f.modifiedAtMs)}
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {/* ── fires ── */}
          <Card>
            <CardHeader title={`Fires (${d.recentFires.length})`} />
            <CardBody className="text-sm">
              {d.recentFires.length === 0 ? (
                <div className="text-xs text-muted">none yet</div>
              ) : (
                <div className="space-y-2">
                  {d.recentFires.map((f) => (
                    <div key={f.id} className="text-xs border-l-2 border-border pl-2">
                      <span className="text-muted">{new Date(f.firedAtMs).toLocaleString()}</span>{" "}
                      {renderOutcome(f.outcome)}{" "}
                      <span className="text-muted">{f.tags.join(", ")}</span>
                      <div className="text-fg whitespace-pre-wrap mt-0.5">{f.brief}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* ── decisions ── */}
          <Card>
            <CardHeader title={`Ghost decisions (${d.decisions.length}, newest first)`} />
            <CardBody className="text-sm">
              {d.decisions.length === 0 ? (
                <div className="text-xs text-muted">none yet</div>
              ) : (
                <div className="space-y-2 max-h-[32rem] overflow-auto pr-1">
                  {d.decisions.map((dec, i) => (
                    <DecisionRow key={`${dec.tickAtMs}-${i}`} d={dec} />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── queued fires ────────────────────────────────────────────────────

function QueuedFiresCard({ sessionKey, queued }: { sessionKey: string; queued: QueuedFire[] }) {
  const cancel = useCancelQueued();
  const reschedule = useRescheduleQueued();
  const [editing, setEditing] = useState<string | null>(null);
  const [newTime, setNewTime] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const startEdit = (q: QueuedFire) => {
    setEditing(q.jobId);
    setErr(null);
    setNewTime(toLocalInput(q.nextFireMs));
  };

  const saveEdit = (jobId: string) => {
    const atMs = new Date(newTime).getTime();
    if (!Number.isFinite(atMs) || atMs <= Date.now()) {
      setErr("pick a future time");
      return;
    }
    reschedule.mutate(
      { sessionKey, jobId, atMs },
      {
        onSuccess: () => {
          setEditing(null);
          setErr(null);
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "failed"),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title={`Queued fires (${queued.length})`}
        subtitle="Brown-noses that are scheduled but haven't gone out yet — delete or move them"
      />
      <CardBody className="text-sm">
        {queued.length === 0 ? (
          <div className="text-xs text-muted">nothing queued</div>
        ) : (
          <div className="space-y-3">
            {queued.map((q) => (
              <div key={q.jobId} className="border border-border rounded p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs">
                    <Badge tone="accent">fires {new Date(q.nextFireMs).toLocaleString()}</Badge>{" "}
                    {q.confidence ? <span className="text-muted">{q.confidence}</span> : null}{" "}
                    <span className="text-muted">{q.tags.join(", ")}</span>
                    {q.expiresAtMs ? (
                      <span className="text-muted">
                        {" "}
                        · expires {new Date(q.expiresAtMs).toLocaleString()}
                      </span>
                    ) : null}
                    <span className="text-muted"> · {q.jobId}</span>
                  </div>
                  <div className="flex gap-1">
                    {editing === q.jobId ? null : (
                      <Button variant="secondary" size="sm" onClick={() => startEdit(q)}>
                        change time
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (confirm("Delete this queued brown-nose? It will never send.")) {
                          cancel.mutate({ sessionKey, jobId: q.jobId });
                        }
                      }}
                    >
                      delete
                    </Button>
                  </div>
                </div>
                {editing === q.jobId ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="datetime-local"
                      className="bg-card border border-border rounded px-2 py-1 text-sm"
                      value={newTime}
                      onChange={(e) => setNewTime(e.target.value)}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={reschedule.isPending}
                      onClick={() => saveEdit(q.jobId)}
                    >
                      {reschedule.isPending ? "saving…" : "save time"}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
                      cancel
                    </Button>
                    {err ? <span className="text-xs text-danger">{err}</span> : null}
                  </div>
                ) : null}
                <div className="text-fg whitespace-pre-wrap text-xs">{q.brief}</div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ─── allowed hours editor ────────────────────────────────────────────

function HoursCard({
  sessionKey,
  timezone,
  activeHours,
}: {
  sessionKey: string;
  timezone: string;
  activeHours: Array<{ dow: string; start: string; end: string }>;
}) {
  const setHours = useSetHours();
  const [rows, setRows] = useState<HoursState>(() => hoursToState(activeHours));
  const [dirty, setDirty] = useState(false);

  // Re-sync from the server whenever the prefs change underneath us and the
  // operator has no unsaved edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialize for cheap deep-compare
  useEffect(() => {
    if (!dirty) setRows(hoursToState(activeHours));
  }, [JSON.stringify(activeHours)]);

  const update = (dow: Dow, patch: Partial<DayRow>) => {
    setRows((r) => ({ ...r, [dow]: { ...r[dow], ...patch } }));
    setDirty(true);
  };

  const save = () => {
    const out = DOWS.filter((d) => rows[d].on).map((d) => ({
      dow: d,
      start: rows[d].start || "09:00",
      end: rows[d].end || "21:00",
    }));
    setHours.mutate({ sessionKey, activeHours: out }, { onSuccess: () => setDirty(false) });
  };

  return (
    <Card>
      <CardHeader
        title="Allowed hours"
        subtitle={`When the ghost may initiate for this chat (${timezone}). All days off = never initiates.`}
        right={
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || setHours.isPending}
            onClick={save}
          >
            {setHours.isPending ? "saving…" : dirty ? "save hours" : "saved"}
          </Button>
        }
      />
      <CardBody className="text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {DOWS.map((dow) => (
            <div
              key={dow}
              className={`flex items-center gap-2 border border-border rounded px-2 py-1.5 ${rows[dow].on ? "" : "opacity-50"}`}
            >
              <label className="flex items-center gap-1.5 w-14 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rows[dow].on}
                  onChange={(e) => update(dow, { on: e.target.checked })}
                />
                <span className="text-xs uppercase font-medium">{dow}</span>
              </label>
              <input
                type="time"
                className="bg-card border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                value={rows[dow].start}
                disabled={!rows[dow].on}
                onChange={(e) => update(dow, { start: e.target.value })}
              />
              <span className="text-xs text-muted">–</span>
              <input
                type="time"
                className="bg-card border border-border rounded px-1.5 py-0.5 text-xs flex-1 min-w-0"
                value={rows[dow].end}
                disabled={!rows[dow].on}
                onChange={(e) => update(dow, { end: e.target.value })}
              />
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function hoursToState(activeHours: Array<{ dow: string; start: string; end: string }>): HoursState {
  const out = {} as HoursState;
  for (const dow of DOWS) {
    const w = activeHours.find((h) => h.dow === dow);
    out[dow] = { on: !!w, start: w?.start ?? "09:00", end: w?.end ?? "21:00" };
  }
  return out;
}

// ─── shared bits ─────────────────────────────────────────────────────

function InvokeResultCard({ result, onDismiss }: { result: InvokeResult; onDismiss: () => void }) {
  return (
    <Card>
      <CardHeader
        title="Forced tick result"
        right={
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            dismiss
          </Button>
        }
      />
      <CardBody className="text-sm space-y-2">
        {result.decision.act ? (
          <>
            <div>
              <Badge tone="ok">ACT</Badge>{" "}
              <span className="text-muted">
                confidence {result.decision.confidence} · {(result.decision.tags ?? []).join(", ")}
              </span>
            </div>
            <div className="text-fg whitespace-pre-wrap">{result.decision.brief}</div>
            {result.enqueue ? (
              result.enqueue.enqueued ? (
                <div className="text-xs text-ok">
                  queued {result.enqueue.jobId} — fires{" "}
                  {result.enqueue.jitteredFireAtMs
                    ? new Date(result.enqueue.jitteredFireAtMs).toLocaleString()
                    : "soon"}
                </div>
              ) : (
                <div className="text-xs text-danger">enqueue failed: {result.enqueue.reason}</div>
              )
            ) : null}
          </>
        ) : (
          <>
            <div>
              <Badge tone="neutral">NO</Badge>
              {result.decision.snoozeUntilMs ? (
                <span className="ml-2 text-xs text-muted">
                  snoozed until {new Date(result.decision.snoozeUntilMs).toLocaleString()}
                </span>
              ) : null}
            </div>
            <div className="text-muted">{result.decision.reason}</div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function DecisionRow({ d }: { d: StoredDecision }) {
  const isGate =
    !d.act &&
    (d.gate !== undefined ||
      /^(cooldown|active_hours|enabled|weekly_cap|no prefs)/.test(d.reason ?? ""));
  return (
    <div className="text-xs border-l-2 border-border pl-2">
      <span className="text-muted">{new Date(d.tickAtMs).toLocaleString()}</span>{" "}
      {d.act ? (
        <>
          <Badge tone="ok">ACT</Badge>{" "}
          {d.confidence ? <span className="text-muted">{d.confidence}</span> : null}{" "}
          <span className="text-muted">{(d.tags ?? []).join(", ")}</span>
          {d.fireAtMs ? (
            <span className="text-muted"> · fire {new Date(d.fireAtMs).toLocaleString()}</span>
          ) : null}
          <div className="text-fg whitespace-pre-wrap mt-0.5">{d.brief}</div>
          {d.contextFiles?.length ? (
            <div className="text-muted mt-0.5">staged: {d.contextFiles.join(", ")}</div>
          ) : null}
        </>
      ) : (
        <>
          <Badge tone={isGate ? "neutral" : "warn"}>{isGate ? "GATE" : "NO"}</Badge>{" "}
          {d.snoozeUntilMs ? (
            <Badge tone="accent">snooze → {new Date(d.snoozeUntilMs).toLocaleString()}</Badge>
          ) : null}
          <div className="text-muted whitespace-pre-wrap mt-0.5">{d.reason}</div>
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function renderOutcome(outcome: "engaged" | "ignored" | "pushed_back" | null) {
  if (outcome === "engaged") return <Badge tone="ok">engaged</Badge>;
  if (outcome === "pushed_back") return <Badge tone="danger">pushed_back</Badge>;
  if (outcome === "ignored") return <Badge tone="warn">ignored</Badge>;
  return <Badge tone="neutral">pending</Badge>;
}

function relAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** unix-ms → value for <input type="datetime-local"> in the browser's TZ. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
