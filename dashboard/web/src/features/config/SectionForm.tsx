import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useEffect, useId, useState } from "react";
import type { Field, Section } from "./fields";

type Props = {
  section: Section;
  values: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => Promise<void>;
  saving: boolean;
};

export function SectionForm({ section, values, onSave, saving }: Props) {
  const [local, setLocal] = useState<Record<string, unknown>>(values);
  useEffect(() => setLocal(values), [values]);
  const dirty = JSON.stringify(local) !== JSON.stringify(values);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        await onSave(local);
      }}
    >
      {section.fields.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          value={local[f.key]}
          onChange={(v) => setLocal({ ...local, [f.key]: v })}
        />
      ))}
      <div className="pt-3 flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {dirty ? <span className="text-xs text-muted">Unsaved changes</span> : null}
      </div>
    </form>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // The label is a sibling of the control, so it needs an explicit htmlFor/id
  // pair — without it clicking the label does nothing and screen readers read
  // the input unlabelled. The "bool" kind nests its own <input> inside a
  // <label>, which is already an implicit association, so it opts out.
  const id = useId();
  const labelled = field.kind !== "bool";
  return (
    <div>
      <label className="block text-xs text-muted mb-1" htmlFor={labelled ? id : undefined}>
        {field.label}
      </label>
      {renderInput(field, value, onChange, labelled ? id : undefined)}
      {field.help ? <p className="text-xs text-muted/70 mt-1">{field.help}</p> : null}
    </div>
  );
}

function renderInput(field: Field, value: unknown, onChange: (v: unknown) => void, id?: string) {
  switch (field.kind) {
    case "text":
    case "password":
      return (
        <Input
          id={id}
          type={field.kind === "password" ? "password" : "text"}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={(value as number | string | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      );
    case "bool":
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="text-muted">{value ? "on" : "off"}</span>
        </label>
      );
    case "enum":
      return (
        <select
          id={id}
          className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm text-fg"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "textarea":
      return (
        <textarea
          id={id}
          className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm text-fg font-mono"
          rows={4}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "list": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <textarea
          id={id}
          className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm text-fg font-mono"
          rows={Math.max(3, Math.min(10, list.length + 1))}
          value={list.join("\n")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );
    }
  }
}
