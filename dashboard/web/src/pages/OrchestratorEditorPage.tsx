import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  ClaudeModelField,
  FILE_HINTS,
  InvocationsInput,
  SharedPersonaPanel,
} from "@/features/orchestrator/fields";
import {
  type UpdateOrchestratorArgs,
  useOrchestrator,
  useUpdateOrchestrator,
} from "@/features/orchestrator/useOrchestrator";
import { ApiError } from "@/lib/api";
import { useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";

type EditorView = { kind: "form" } | { kind: "persona"; file: string };

/** The persona's settings page ( /orchestrator/main ): the names it answers
 *  to, its model and its persona files. Persona editing swaps the form for a
 *  full-width view on this same page — no dialogs. */
export function OrchestratorEditorPage() {
  const { key } = useParams<{ key: string }>();
  const { data, isLoading } = useOrchestrator();
  const update = useUpdateOrchestrator();
  const toast = useToast();

  const orch = (data?.orchestrators ?? []).find((o) => o.key === key) ?? null;

  const [view, setView] = useState<EditorView>({ kind: "form" });
  const [invocations, setInvocations] = useState<string[]>([]);

  // `Name` labels one input (htmlFor). The invocations editor is a group of
  // controls, so it is labelled via aria-labelledby: htmlFor can only point
  // at one control, and the component does not forward an id to it.
  const nameId = useId();
  const invocationsLabelId = useId();
  const [model, setModel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Initialize once the persona arrives. Keyed on the key so background
  // refetches don't clobber in-progress edits.
  const orchKey = orch?.key ?? null;
  // Intentionally keyed on orchKey ONLY: adding `orch` would re-run on every
  // background refetch and overwrite whatever the user is currently typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see note above
  useEffect(() => {
    if (orch) {
      setInvocations(orch.invocations);
      setModel(orch.model);
      setErr(null);
      setView({ kind: "form" });
    }
  }, [orchKey]);

  const dirty = orch
    ? invocations.join("\n") !== orch.invocations.join("\n") || model.trim() !== orch.model
    : false;

  async function saveEdit() {
    if (!orch) return;
    setErr(null);
    const body: UpdateOrchestratorArgs = { key: orch.key };
    if (invocations.join("\n") !== orch.invocations.join("\n")) body.invocations = invocations;
    if (model.trim() !== orch.model) body.model = model.trim();
    try {
      await update.mutateAsync(body);
      toast.push({
        tone: "ok",
        title: `${orch.name} saved`,
        description: "Invocation and model changes need a daemon restart.",
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr(e.message);
      else
        toast.push({
          tone: "danger",
          title: "Save failed",
          description: e instanceof Error ? e.message : String(e),
        });
    }
  }

  // While data loads / unknown key.
  if (!orch) {
    return (
      <div>
        <PageHeader
          title={key ?? ""}
          actions={
            <Link to="/orchestrator" className="text-sm text-muted hover:text-fg">
              ← orchestrator
            </Link>
          }
        />
        <p className="text-sm text-muted">
          {isLoading || !data ? "Loading…" : `No persona with key "${key}".`}
        </p>
      </div>
    );
  }

  const saveButton = (
    <Button variant="primary" disabled={!dirty || update.isPending} onClick={saveEdit}>
      {update.isPending ? "Saving…" : "Save changes"}
    </Button>
  );

  return (
    <div>
      {/* The form stays mounted underneath the persona view so in-progress
          edits survive the round-trip. */}
      <div className={view.kind === "form" ? undefined : "hidden"}>
        <PageHeader
          title={orch.name}
          description="The persona. Its files are the persona/ originals; its model is [claude].model."
          actions={
            <>
              <Link to="/orchestrator" className="text-sm text-muted hover:text-fg">
                ← orchestrator
              </Link>
              {saveButton}
            </>
          }
        />

        <div className="max-w-3xl space-y-4">
          <Card>
            <CardHeader
              title="Identity"
              subtitle="What it is called and which names it answers to."
            />
            <CardBody className="space-y-4">
              <div>
                <label className="text-xs font-medium text-fg" htmlFor={nameId}>
                  Name
                </label>
                <Input id={nameId} value={orch.name} disabled className="mt-1.5" />
                <div className="text-[11px] text-muted mt-1">
                  Derived from the first invocation name below.
                </div>
              </div>

              <div>
                <span id={invocationsLabelId} className="text-xs font-medium text-fg">
                  Invocation names
                </span>
                <InvocationsInput
                  aria-labelledby={invocationsLabelId}
                  value={invocations}
                  onChange={setInvocations}
                  className="mt-1.5"
                />
                <p className="text-[11px] text-muted mt-1">
                  These are [identity].names — what the persona answers to in group chats.
                </p>
                {err ? (
                  <div className="mt-1.5 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
                    {err}
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Model"
              subtitle="Every conversation runs directly through the Claude Code CLI."
            />
            <CardBody>
              <ClaudeModelField
                value={model}
                onChange={setModel}
                idPrefix={`orch-${orch.key}`}
                placeholder="claude-…"
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Persona files" subtitle="The persona/ originals." />
            <CardBody>
              <div className="rounded-md border border-border divide-y divide-border">
                {orch.persona.map((p) => (
                  <div key={p.file} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 flex items-center gap-2">
                      <span className="text-xs font-mono text-fg">{p.file}</span>
                      <Badge tone={p.source === "missing" ? "danger" : "neutral"}>{p.source}</Badge>
                      <span className="text-[11px] text-muted hidden sm:inline">
                        {FILE_HINTS[p.file]}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setView({ kind: "persona", file: p.file })}
                      >
                        Edit
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <div className="flex justify-end">{saveButton}</div>
        </div>
      </div>

      {view.kind === "persona" ? (
        <SharedPersonaPanel name={view.file} onBack={() => setView({ kind: "form" })} />
      ) : null}
    </div>
  );
}
