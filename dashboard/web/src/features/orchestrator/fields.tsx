import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  useOrchPersonaFile,
  usePersonaFile,
  useRevertOrchPersona,
  useSaveOrchPersona,
  useSavePersona,
} from "@/features/orchestrator/useOrchestrator";
import { cn } from "@/lib/cn";
import { type KeyboardEvent, useEffect, useState } from "react";

// Shared building blocks for the orchestrator pages (list + editor).
// No dialogs in this flow — model picking and persona editing are full-width
// in-page views the owning page swaps in.

export const ANTHROPIC_MODELS = [
  "claude-fable-5[1m]",
  "claude-fable-5",
  "claude-opus-4-8[1m]",
  "claude-opus-4-8",
  "claude-sonnet-4-6[1m]",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

export const ORCH_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "VENUE_DM.md", "VENUE_GROUP.md"];

export const FILE_HINTS: Record<string, string> = {
  "IDENTITY.md": "who this persona is",
  "SOUL.md": "voice and values",
  "AGENTS.md": "operating instructions",
  "VENUE_DM.md": "DM behavior",
  "VENUE_GROUP.md": "group-chat behavior",
};

/** Mirrors the server's key derivation so the preview matches what POST creates. */
export function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

// ─── Role toggle option ──────────────────────────────────────────────────────

export function RoleOption(props: {
  active: boolean;
  disabled?: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition-colors",
        props.active ? "border-accent bg-accent/10" : "border-border hover:border-muted",
        props.disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      <div className="text-xs font-medium text-fg">{props.title}</div>
      <div className="text-[11px] text-muted mt-0.5">{props.desc}</div>
    </button>
  );
}

// ─── Invocation chips input ──────────────────────────────────────────────────

export function InvocationsInput(props: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const { value, onChange, placeholder, className } = props;
  const [text, setText] = useState("");

  function commit() {
    const tokens = text
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = [...value];
    for (const t of tokens) if (!next.includes(t)) next.push(t);
    onChange(next);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 focus-within:ring-2 focus-within:ring-accent",
        className,
      )}
    >
      {value.map((inv) => (
        <span
          key={inv}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-accent/30 bg-accent/10 text-xs font-mono text-fg"
        >
          {inv}
          <button
            type="button"
            aria-label={`remove ${inv}`}
            onClick={() => onChange(value.filter((v) => v !== inv))}
            className="text-muted hover:text-danger leading-none"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[8rem] bg-transparent text-xs font-mono text-fg placeholder:text-muted focus:outline-none py-0.5"
      />
    </div>
  );
}

// ─── Claude Code model field ─────────────────────────────────────────────────

export function ClaudeModelField(props: {
  value: string;
  onChange: (v: string) => void;
  idPrefix: string;
  placeholder: string;
}) {
  const { value, onChange, idPrefix, placeholder } = props;
  const listId = `${idPrefix}-anthropic-models`;

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-fg">Claude Code model</span>
        <Badge tone="ok">Max subscription</Badge>
      </div>
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 font-mono text-xs"
      />
      <datalist id={listId}>
        {ANTHROPIC_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <p className="text-[11px] text-muted mt-1">Spawned directly through the Claude Code CLI.</p>
    </div>
  );
}

// ─── Shared persona/*.md editor (in-page) ────────────────────────────────────

export function SharedPersonaPanel({ name, onBack }: { name: string; onBack: () => void }) {
  const { data, isLoading } = usePersonaFile(name);
  const save = useSavePersona();
  const toast = useToast();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (data) setDraft(data.content);
  }, [data]);

  const dirty = data ? draft !== data.content : false;

  async function onSave() {
    try {
      await save.mutateAsync({ name, content: draft });
      toast.push({
        tone: "ok",
        title: `${name} saved`,
        description: "Previous version backed up to persona/.backups/. Applies on the next turn.",
      });
      onBack();
    } catch (e) {
      toast.push({ tone: "danger", title: "Save failed", description: (e as Error).message });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg font-mono">{name}</h2>
          <p className="text-xs text-muted mt-0.5 max-w-2xl">
            Shared persona file — edits land on disk immediately and apply on the next model turn. A
            timestamped backup is kept in persona/.backups/. Orchestrators with a custom override
            keep their own copy.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-muted hover:text-fg shrink-0"
        >
          ← back
        </button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-[60vh] resize-y bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">
              {draft.length.toLocaleString()} chars{dirty ? " • unsaved changes" : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onBack}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Per-orchestrator persona override editor (in-page) ──────────────────────

export function OrchPersonaPanel({
  orchKey,
  file,
  onBack,
}: {
  orchKey: string;
  file: string;
  onBack: () => void;
}) {
  const { data, isLoading, error } = useOrchPersonaFile(orchKey, file);
  const save = useSaveOrchPersona();
  const revert = useRevertOrchPersona();
  const toast = useToast();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (data) setDraft(data.content);
    else if (error) setDraft("");
  }, [data, error]);

  const isCustom = data?.source === "custom";
  const dirty = data ? draft !== data.content : draft.length > 0;

  async function onSave() {
    try {
      await save.mutateAsync({ key: orchKey, file, content: draft });
      toast.push({
        tone: "ok",
        title: `${file} saved for ${orchKey}`,
        description: "Custom override written — applies on the next turn, no restart.",
      });
      onBack();
    } catch (e) {
      toast.push({ tone: "danger", title: "Save failed", description: (e as Error).message });
    }
  }

  async function onRevert() {
    try {
      await revert.mutateAsync({ key: orchKey, file });
      toast.push({
        tone: "ok",
        title: `${file} reverted to shared`,
        description: "The custom override was backed up to persona/.backups/.",
      });
      onBack();
    } catch (e) {
      toast.push({ tone: "danger", title: "Revert failed", description: (e as Error).message });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg font-mono">
            {orchKey} / {file}
          </h2>
          <p className="text-xs text-muted mt-0.5 max-w-2xl">
            {isCustom
              ? `Custom override at persona/orchestrators/${orchKey}/${file}. Edits apply on the next turn.`
              : `Currently inheriting the shared persona/${file} — saving creates a custom copy for ${orchKey} only.`}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-muted hover:text-fg shrink-0"
        >
          ← back
        </button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          {error ? (
            <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              No shared file exists for this name — saving creates it fresh for this orchestrator.
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-[60vh] resize-y bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">
              {draft.length.toLocaleString()} chars{dirty ? " • unsaved changes" : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onBack}>
                Cancel
              </Button>
              {isCustom ? (
                <Button variant="danger" disabled={revert.isPending} onClick={onRevert}>
                  {revert.isPending ? "Reverting…" : "Revert to shared"}
                </Button>
              ) : null}
              <Button variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
                {save.isPending ? "Saving…" : isCustom ? "Save" : "Save as custom"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
