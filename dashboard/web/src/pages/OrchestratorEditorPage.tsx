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
  ORCH_FILES,
  OrchPersonaPanel,
  RoleOption,
  SharedPersonaPanel,
  slugifyKey,
} from "@/features/orchestrator/fields";
import {
  type OrchRole,
  type UpdateOrchestratorArgs,
  useCreateOrchestrator,
  useDeleteOrchestrator,
  useOrchestrator,
  useRevertOrchPersona,
  useUpdateOrchestrator,
} from "@/features/orchestrator/useOrchestrator";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

type EditorView = { kind: "form" } | { kind: "persona"; file: string };

/** Nested page for creating ( /orchestrator/new ) or editing
 *  ( /orchestrator/:key ) one orchestrator. Persona editing swaps the form
 *  for a full-width view on this same page — no dialogs. */
export function OrchestratorEditorPage() {
  const { key } = useParams<{ key: string }>();
  const isCreate = !key;
  const navigate = useNavigate();
  const { data, isLoading } = useOrchestrator();
  const create = useCreateOrchestrator();
  const update = useUpdateOrchestrator();
  const del = useDeleteOrchestrator();
  const revertPersona = useRevertOrchPersona();
  const toast = useToast();

  const orch = isCreate ? null : ((data?.orchestrators ?? []).find((o) => o.key === key) ?? null);

  const [view, setView] = useState<EditorView>({ kind: "form" });
  const [name, setName] = useState("");
  const [invocations, setInvocations] = useState<string[]>([]);
  const [role, setRole] = useState<OrchRole>("secondary");

  // Field labels: `Name` labels one input (htmlFor). The other three label a
  // GROUP of controls (role cards and an invocations editor), so
  // they are group labels via aria-labelledby — htmlFor can only point at one
  // control, and these custom components do not forward an id to it.
  const nameId = useId();
  const roleLabelId = useId();
  const invocationsLabelId = useId();
  const [model, setModel] = useState("");
  const [personaModes, setPersonaModes] = useState<Record<string, "shared" | "custom">>({});
  const [err, setErr] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState(false);

  // Edit mode: initialize once the orchestrator arrives. Keyed on the key so
  // background refetches don't clobber in-progress edits.
  const orchKey = orch?.key ?? null;
  // Intentionally keyed on orchKey ONLY: adding `orch` would re-run on every
  // background refetch and overwrite whatever the user is currently typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see note above
  useEffect(() => {
    if (orch) {
      setName(orch.name);
      setInvocations(orch.invocations);
      setRole(orch.role);
      setModel(orch.model);
      setErr(null);
      setArmDelete(false);
      setView({ kind: "form" });
    }
  }, [orchKey]);

  const previewKey = slugifyKey(name);
  const defaultInvocation = name.trim() ? name.trim().toLowerCase() : "";
  const displayName = isCreate ? name.trim() || "New orchestrator" : (orch?.name ?? key ?? "");

  const dirty = orch
    ? (!orch.builtin && name.trim() !== orch.name) ||
      invocations.join("\n") !== orch.invocations.join("\n") ||
      (role !== orch.role && !(orch.builtin && role !== "primary")) ||
      model.trim() !== orch.model
    : false;

  async function submitCreate() {
    setErr(null);
    if (!name.trim()) {
      setErr("Give the orchestrator a name.");
      return;
    }
    const persona: Record<string, { mode: "shared" | "custom" }> = {};
    for (const f of ORCH_FILES) {
      if (f === "IDENTITY.md") continue; // server always scaffolds a custom identity
      if (personaModes[f] === "custom") persona[f] = { mode: "custom" };
    }
    try {
      const res = await create.mutateAsync({
        name: name.trim(),
        invocations: invocations.length > 0 ? invocations : [defaultInvocation],
        role,
        model: model.trim() || undefined,
        persona: Object.keys(persona).length > 0 ? persona : undefined,
      });
      toast.push({
        tone: "ok",
        title: `${name.trim()} created`,
        description: `Scaffolded ${res.scaffolded.join(", ") || "no files"}. Restart the daemon to activate routing, then edit its IDENTITY.md to give it a personality.`,
      });
      navigate(`/orchestrator/${res.key}`, { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveEdit() {
    if (!orch) return;
    setErr(null);
    const body: UpdateOrchestratorArgs = { key: orch.key };
    if (!orch.builtin && name.trim() && name.trim() !== orch.name) body.name = name.trim();
    if (invocations.join("\n") !== orch.invocations.join("\n")) body.invocations = invocations;
    if (role !== orch.role && !(orch.builtin && role !== "primary")) body.role = role;
    if (model.trim() !== orch.model) body.model = model.trim();
    try {
      await update.mutateAsync(body);
      toast.push({
        tone: "ok",
        title: `${orch.name} saved`,
        description: "Name, invocation, role and model changes need a daemon restart.",
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

  async function onDelete() {
    if (!orch) return;
    if (!armDelete) {
      setArmDelete(true);
      return;
    }
    try {
      await del.mutateAsync(orch.key);
      toast.push({
        tone: "ok",
        title: `${orch.name} deleted`,
        description:
          "Config entry removed; persona files kept on disk. Restart the daemon to drop its routing.",
      });
      navigate("/orchestrator");
    } catch (e) {
      toast.push({
        tone: "danger",
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function revertFile(file: string) {
    if (!orch) return;
    try {
      await revertPersona.mutateAsync({ key: orch.key, file });
      toast.push({
        tone: "ok",
        title: `${file} reverted to shared`,
        description: "The custom override was backed up to persona/.backups/.",
      });
    } catch (e) {
      toast.push({
        tone: "danger",
        title: "Revert failed",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Edit mode while data loads / unknown key.
  if (!isCreate && !orch) {
    return (
      <div>
        <PageHeader
          title={key ?? ""}
          actions={
            <Link to="/orchestrator" className="text-sm text-muted hover:text-fg">
              ← orchestrators
            </Link>
          }
        />
        <p className="text-sm text-muted">
          {isLoading || !data ? "Loading…" : `No orchestrator with key "${key}".`}
        </p>
      </div>
    );
  }

  const saveButton = isCreate ? (
    <Button variant="primary" disabled={create.isPending || !name.trim()} onClick={submitCreate}>
      {create.isPending ? "Creating…" : "Create orchestrator"}
    </Button>
  ) : (
    <Button variant="primary" disabled={!dirty || update.isPending} onClick={saveEdit}>
      {update.isPending ? "Saving…" : "Save changes"}
    </Button>
  );

  return (
    <div>
      {/* The form stays mounted underneath picker/persona views so in-progress
          edits (including the provider toggle) survive the round-trip. */}
      <div className={view.kind === "form" ? undefined : "hidden"}>
        <PageHeader
          title={isCreate ? "New orchestrator" : displayName}
          description={
            isCreate
              ? "A persona that lives alongside the main one. Call it by name in any chat and it answers in its own voice, with its own Claude Code model and persona files."
              : orch?.builtin
                ? "The built-in main persona. Its files are the shared persona/ originals; its model is [claude].model."
                : `Sessions run as orch:${orch?.key}:dm|group:… with their own history and sandbox.`
          }
          actions={
            <>
              <Link to="/orchestrator" className="text-sm text-muted hover:text-fg">
                ← orchestrators
              </Link>
              {saveButton}
            </>
          }
        />

        <div className="max-w-3xl space-y-4">
          <Card>
            <CardHeader
              title="Identity"
              subtitle="Who this orchestrator is and which messages route to it."
            />
            <CardBody className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-fg" htmlFor={nameId}>
                    Name
                  </label>
                  <Input
                    id={nameId}
                    autoFocus={isCreate}
                    value={name}
                    disabled={orch?.builtin}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={isCreate ? "Desmond" : undefined}
                    className="mt-1.5"
                  />
                  {isCreate && previewKey ? (
                    <div className="text-[11px] text-muted mt-1">
                      key <span className="font-mono text-fg">{previewKey}</span> — sessions run as{" "}
                      <span className="font-mono">orch:{previewKey}:…</span>
                    </div>
                  ) : null}
                  {orch?.builtin ? (
                    <div className="text-[11px] text-muted mt-1">
                      Derived from the first invocation name below.
                    </div>
                  ) : null}
                </div>
                <div>
                  <span id={roleLabelId} className="text-xs font-medium text-fg">
                    Role
                  </span>
                  {orch?.builtin && orch.role === "primary" ? (
                    <div className="mt-1.5 rounded-md border border-border px-3 py-2">
                      <div className="text-xs font-medium text-fg">Primary</div>
                      <div className="text-[11px] text-muted mt-0.5">
                        Main is primary while no other orchestrator claims the role.
                      </div>
                    </div>
                  ) : (
                    <div
                      className="mt-1.5 grid grid-cols-2 gap-2"
                      // biome-ignore lint/a11y/useSemanticElements: <fieldset> would reflow this grid
                      role="group"
                      aria-labelledby={roleLabelId}
                    >
                      <RoleOption
                        active={role === "secondary"}
                        disabled={orch?.builtin}
                        title="Secondary"
                        desc={
                          orch?.builtin ? "Demote via another primary" : "Responds only when named"
                        }
                        onClick={() => setRole("secondary")}
                      />
                      <RoleOption
                        active={role === "primary"}
                        title="Primary"
                        desc="Takes over un-named DMs"
                        onClick={() => setRole("primary")}
                      />
                    </div>
                  )}
                  {role === "primary" && (isCreate || orch?.role !== "primary") ? (
                    <div className="text-[11px] text-warn mt-1">
                      Demotes the current primary — un-named messages will route here instead.
                    </div>
                  ) : null}
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
                  placeholder={
                    isCreate
                      ? defaultInvocation
                        ? `${defaultInvocation} (default)`
                        : "type a name, press Enter"
                      : undefined
                  }
                  className="mt-1.5"
                />
                <p className="text-[11px] text-muted mt-1">
                  {orch?.builtin
                    ? "These are [identity].names — what the main persona answers to in group chats."
                    : "Messages that use one of these names route to this orchestrator. Press Enter or comma to add more (nicknames, shorthands). Names already taken by another orchestrator are rejected."}
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
                idPrefix={isCreate ? "new-orch" : `orch-${orch?.key}`}
                placeholder={orch?.builtin ? "claude-…" : "(inherit main operator model)"}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Persona files"
              subtitle={
                isCreate
                  ? "Shared files follow the persona/ originals; custom files start as a copy you can rewrite for this orchestrator only."
                  : orch?.builtin
                    ? "The shared persona/ originals — edits here apply to every orchestrator that hasn't customized them."
                    : "Shared files inherit the persona/ originals; Customize copies one for this orchestrator only. Persona edits apply on the next turn — no restart."
              }
            />
            <CardBody>
              {isCreate ? (
                <>
                  <div className="rounded-md border border-border divide-y divide-border">
                    {ORCH_FILES.map((f) => {
                      const locked = f === "IDENTITY.md";
                      const mode = locked ? "custom" : (personaModes[f] ?? "shared");
                      return (
                        <div key={f} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-mono text-fg">{f}</div>
                            <div className="text-[11px] text-muted">{FILE_HINTS[f]}</div>
                          </div>
                          <div className="flex rounded-md border border-border overflow-hidden shrink-0">
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => setPersonaModes((p) => ({ ...p, [f]: "shared" }))}
                              className={cn(
                                "px-2.5 py-1 text-[11px] transition-colors",
                                mode === "shared"
                                  ? "bg-accent/15 text-accent"
                                  : "text-muted hover:text-fg",
                                locked && "opacity-40 cursor-not-allowed",
                              )}
                            >
                              Shared
                            </button>
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => setPersonaModes((p) => ({ ...p, [f]: "custom" }))}
                              className={cn(
                                "px-2.5 py-1 text-[11px] border-l border-border transition-colors",
                                mode === "custom"
                                  ? "bg-accent/15 text-accent"
                                  : "text-muted hover:text-fg",
                                locked && "opacity-40 cursor-not-allowed",
                              )}
                            >
                              Custom
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted mt-2">
                    IDENTITY.md is always custom: it defines who this persona is. You can edit the
                    files right after creating.
                  </p>
                </>
              ) : (
                <div className="rounded-md border border-border divide-y divide-border">
                  {(orch?.persona ?? []).map((p) => (
                    <div key={p.file} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 flex items-center gap-2">
                        <span className="text-xs font-mono text-fg">{p.file}</span>
                        <Badge
                          tone={
                            p.source === "custom"
                              ? "accent"
                              : p.source === "missing"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {p.source}
                        </Badge>
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
                          {orch?.builtin ? "Edit" : p.source === "custom" ? "Edit" : "Customize"}
                        </Button>
                        {!orch?.builtin && p.source === "custom" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={revertPersona.isPending}
                            onClick={() => revertFile(p.file)}
                          >
                            Revert
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {orch && !orch.builtin ? (
            <div className="border-t border-border pt-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted">
                Removes the config entry. Persona files stay on disk under persona/orchestrators/
                {orch.key}/.
              </p>
              <Button size="sm" variant="danger" disabled={del.isPending} onClick={onDelete}>
                {del.isPending ? "Deleting…" : armDelete ? "Confirm delete" : "Delete"}
              </Button>
            </div>
          ) : null}

          <div className="flex justify-end">{saveButton}</div>
        </div>
      </div>

      {view.kind === "persona" && orch ? (
        orch.builtin ? (
          <SharedPersonaPanel name={view.file} onBack={() => setView({ kind: "form" })} />
        ) : (
          <OrchPersonaPanel
            orchKey={orch.key}
            file={view.file}
            onBack={() => setView({ kind: "form" })}
          />
        )
      ) : null}
    </div>
  );
}
