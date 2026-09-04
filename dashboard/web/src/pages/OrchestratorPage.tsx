import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ANTHROPIC_MODELS, SharedPersonaPanel } from "@/features/orchestrator/fields";
import {
  type NamedOrchestrator,
  type OrchSubsystem,
  useOrchestrator,
  useUpdateSubsystem,
} from "@/features/orchestrator/useOrchestrator";
import { cn } from "@/lib/cn";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

// Creating and editing orchestrators happens on nested pages
// ( /orchestrator/new, /orchestrator/:key ) — no dialogs. Shared persona
// editing is the only full-width in-page view swap here.

type MainView = { kind: "list" } | { kind: "persona"; name: string };

export function OrchestratorPage() {
  const { data, isLoading } = useOrchestrator();
  const navigate = useNavigate();
  const [view, setView] = useState<MainView>({ kind: "list" });

  const operator = data?.subsystems.find((s) => s.key === "operator");
  const infra = (data?.subsystems ?? []).filter((s) => s.key !== "operator");
  const orchestrators = useMemo(() => {
    const list = data?.orchestrators ?? [];
    return [...list].sort(
      (a, b) => (a.role === "primary" ? 0 : 1) - (b.role === "primary" ? 0 : 1),
    );
  }, [data?.orchestrators]);

  return (
    <div>
      {/* List stays mounted underneath the picker/persona views so unsaved
          model-editor drafts survive the round-trip. */}
      <div className={view.kind === "list" ? undefined : "hidden"}>
        <PageHeader
          title="Orchestrator"
          description="Named personas and infrastructure models, all run directly through the Claude Code CLI."
        />
        {isLoading || !data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-fg">Orchestrators</h2>
                  <p className="text-xs text-muted mt-0.5 max-w-2xl">
                    Named personas. The <span className="text-fg">primary</span> answers every
                    message that doesn't name someone else; a{" "}
                    <span className="text-fg">secondary</span> responds only when called by one of
                    its names — and the primary never sees those exchanges.
                  </p>
                </div>
                <Button size="sm" variant="primary" onClick={() => navigate("/orchestrator/new")}>
                  New orchestrator
                </Button>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {orchestrators.map((o) => (
                  <OrchestratorCard
                    key={o.key}
                    orch={o}
                    onConfigure={() => navigate(`/orchestrator/${o.key}`)}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-fg">Infrastructure models</h2>
                <p className="text-xs text-muted mt-0.5">
                  Background subsystems run through Claude Code. The operator model itself is edited
                  on the main orchestrator card above.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {infra.map((sub) => (
                  <SubsystemCard
                    key={sub.key}
                    sub={sub}
                    onEditPersona={(name) => setView({ kind: "persona", name })}
                  />
                ))}
              </div>
            </section>

            {operator ? (
              <ContextCard
                compact={data.compact}
                effort={data.effort}
                personaFiles={data.personaFiles.map((f) => f.name)}
                onEditPersona={(name) => setView({ kind: "persona", name })}
              />
            ) : null}
          </div>
        )}
      </div>

      {view.kind === "persona" ? (
        <SharedPersonaPanel name={view.name} onBack={() => setView({ kind: "list" })} />
      ) : null}
    </div>
  );
}

// ─── Orchestrator summary cards ──────────────────────────────────────────────

function OrchestratorCard({
  orch,
  onConfigure,
}: {
  orch: NamedOrchestrator;
  onConfigure: () => void;
}) {
  const custom = orch.persona.filter((p) => p.source === "custom").length;
  const missing = orch.persona.filter((p) => p.source === "missing").length;

  return (
    <Card className={cn(orch.role === "primary" && "border-accent/40")}>
      <CardHeader
        title={orch.name}
        subtitle={
          orch.role === "primary"
            ? "Primary — answers un-named DMs and group messages"
            : "Secondary — responds only when called by name"
        }
        right={
          <div className="flex items-center gap-1.5">
            {orch.builtin ? <Badge tone="neutral">built-in</Badge> : null}
            <Badge tone={orch.role === "primary" ? "accent" : "neutral"}>{orch.role}</Badge>
          </div>
        }
      />
      <CardBody className="space-y-3">
        <div>
          <div className="text-xs font-medium text-fg mb-1.5">Answers to</div>
          <div className="flex flex-wrap gap-1.5">
            {orch.invocations.map((inv) => (
              <span
                key={inv}
                className="px-2 py-0.5 rounded-md border border-border bg-card text-xs font-mono text-fg"
              >
                {inv}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-1 text-xs text-muted">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0">Model</span>
            <span className="font-mono text-fg truncate">{orch.effectiveModel}</span>
            {orch.inheritsOperator ? <Badge tone="neutral">inherits main</Badge> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {orch.persona.map((p) => (
            <span
              key={p.file}
              title={`${p.file}: ${p.source}`}
              className={cn(
                "px-2 py-0.5 rounded-md border text-[11px] font-mono",
                p.source === "custom" && "border-accent/40 text-accent",
                p.source === "shared" && "border-border/60 text-muted",
                p.source === "missing" && "border-danger/40 text-danger",
              )}
            >
              {p.file.replace(/\.md$/, "")}
            </span>
          ))}
          <span className="text-[11px] text-muted ml-1">
            {custom ? `${custom} custom` : "all shared"}
            {missing ? ` / ${missing} missing` : ""}
          </span>
        </div>

        <div className="border-t border-border pt-3 flex justify-end">
          <Button size="sm" variant="secondary" onClick={onConfigure}>
            Configure
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Subsystem cards (ghost, maintainer, trading, agents) ────────────────────

function SubsystemCard(props: {
  sub: OrchSubsystem;
  onEditPersona: (name: string) => void;
}) {
  const { sub, onEditPersona } = props;
  return (
    <Card>
      <CardHeader title={sub.label} subtitle={sub.description} />
      <CardBody className="space-y-4">
        <ModelEditor sub={sub} />
        {sub.personaFiles.length ? (
          <div className="flex flex-wrap gap-1.5">
            {sub.personaFiles.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => onEditPersona(name)}
                className="px-2.5 py-1 rounded-md border border-border bg-card text-xs font-mono text-fg hover:border-accent hover:text-accent transition-colors"
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ─── Primary (Anthropic) model editor ────────────────────────────────────────

function ModelEditor({ sub }: { sub: OrchSubsystem }) {
  const update = useUpdateSubsystem();
  const toast = useToast();
  const [value, setValue] = useState(sub.model);
  useEffect(() => setValue(sub.model), [sub.model]);
  const dirty = value !== sub.model;
  const listId = `anthropic-models-${sub.key}`;

  async function save() {
    try {
      await update.mutateAsync({ key: sub.key, model: value });
      toast.push({ tone: "ok", title: `${sub.label}: primary model saved` });
    } catch (e) {
      toast.push({ tone: "danger", title: "Save failed", description: (e as Error).message });
    }
  }

  return (
    <div>
      <div className="text-xs font-medium text-fg mb-1.5 flex items-center gap-2">
        Primary model
        <Badge tone="ok">Anthropic / Max sub</Badge>
        {sub.inheritsOperator ? <Badge tone="neutral">inherits operator</Badge> : null}
      </div>
      <div className="flex gap-2">
        <Input
          list={listId}
          value={value}
          placeholder={sub.key === "trading" ? "(empty = inherit operator model)" : "claude-…"}
          onChange={(e) => setValue(e.target.value)}
          className="font-mono text-xs"
        />
        <datalist id={listId}>
          {ANTHROPIC_MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {dirty ? (
          <Button size="sm" variant="primary" disabled={update.isPending} onClick={save}>
            Save
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Context management + persona library ────────────────────────────────────

function ContextCard(props: {
  compact: { enabled: boolean; threshold_tokens: number };
  effort: string;
  personaFiles: string[];
  onEditPersona: (name: string) => void;
}) {
  const { compact, effort, personaFiles, onEditPersona } = props;

  return (
    <Card>
      <CardHeader
        title="Context management and persona library"
        subtitle="Claude Code auto-compact behavior, plus every persona file on disk."
      />
      <CardBody className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2 text-xs text-muted">
          <div>
            <div className="font-medium text-fg mb-1">Context management</div>
            {compact.enabled ? (
              <p>
                Auto-compact trips at {fmtTokens(compact.threshold_tokens)} tokens using the
                configured Claude Code model.
              </p>
            ) : (
              <p>Auto-compact is disabled in config.</p>
            )}
          </div>
          <div>
            <div className="font-medium text-fg mb-1">Effort</div>
            <p>
              Runs at <span className="text-fg font-medium">{effort}</span> effort (config
              [claude].effort — edit on the Claude settings page).
            </p>
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <div className="text-xs font-medium text-fg mb-2">
            All persona files
            <span className="text-muted font-normal ml-2">
              persona/*.md — hot-read every turn. Shared across the main persona and any
              orchestrator that hasn't customized them.
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {personaFiles.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => onEditPersona(name)}
                className="px-2.5 py-1 rounded-md border border-border bg-card text-xs font-mono text-fg hover:border-accent hover:text-accent transition-colors"
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
