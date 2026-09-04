import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useContacts, useSaveContacts } from "@/features/contacts/useContacts";
import type { ContactDto } from "@api/types";
import { useEffect, useRef, useState } from "react";

/**
 * A draft row carries a client-side id so React can key on identity rather
 * than array position. Keying on the index made a delete visually "move" the
 * text you had typed: removing row 2 of 5 shifted every later row up one, and
 * React reused the DOM node (and its focus/selection) for whatever contact now
 * occupied that slot. The id never leaves the browser — `persist()` strips it.
 */
type DraftRow = { id: number; value: ContactDto };

export function ContactsPage() {
  const { data, isLoading } = useContacts();
  const save = useSaveContacts();
  const toast = useToast();
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const nextId = useRef(0);

  useEffect(() => {
    if (data?.contacts && !dirty) {
      setDraft(data.contacts.map((value) => ({ id: nextId.current++, value })));
    }
  }, [data, dirty]);

  function update(id: number, patch: Partial<ContactDto>) {
    setDraft((cur) =>
      cur.map((r) => (r.id === id ? { ...r, value: { ...r.value, ...patch } } : r)),
    );
    setDirty(true);
  }

  function remove(id: number) {
    setDraft((cur) => cur.filter((r) => r.id !== id));
    setDirty(true);
  }

  function add() {
    setDraft((cur) => [
      ...cur,
      { id: nextId.current++, value: { name: "", handles: [], notes: "" } },
    ]);
    setDirty(true);
  }

  async function persist() {
    const cleaned = draft
      .map(({ value: c }) => ({
        ...c,
        name: c.name?.trim() || undefined,
        handles: c.handles.map((h) => h.trim()).filter(Boolean),
        notes: c.notes?.trim() || undefined,
      }))
      .filter((c) => c.handles.length > 0);
    try {
      const res = await save.mutateAsync(cleaned);
      toast.push({ tone: "ok", title: "Contacts saved", description: `backup: ${res.backup}` });
      setDirty(false);
    } catch (e) {
      toast.push({ tone: "danger", title: "Save failed", description: (e as Error).message });
    }
  }

  return (
    <div>
      <PageHeader
        title="Contacts"
        description="Manual contact book. Names here override macOS Contacts.app for the bot's display labels and prompt context."
        actions={
          <div className="flex gap-2">
            <Button onClick={add}>Add contact</Button>
            <Button variant="primary" disabled={!dirty || save.isPending} onClick={persist}>
              {save.isPending ? "Saving…" : "Save all"}
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : draft.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-muted">
            No contacts yet. Click "Add contact" to create one. The bot will fall back to macOS
            Contacts.app for handles not listed here.
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {draft.map(({ id, value: c }, i) => (
            <Card key={id}>
              <CardHeader
                title={c.name || `Contact ${i + 1}`}
                right={
                  <Button size="sm" variant="danger" onClick={() => remove(id)}>
                    Remove
                  </Button>
                }
              />
              <CardBody className="space-y-2">
                <Field label="Name">
                  <input
                    className="w-full bg-card border border-border rounded px-2 py-1 text-sm"
                    value={c.name ?? ""}
                    onChange={(e) => update(id, { name: e.target.value })}
                  />
                </Field>
                <Field label="Handles (one per line — phone E.164 or email)">
                  <textarea
                    className="w-full bg-card border border-border rounded px-2 py-1 text-sm font-mono"
                    rows={Math.max(2, c.handles.length)}
                    value={c.handles.join("\n")}
                    onChange={(e) =>
                      update(id, {
                        handles: e.target.value
                          .split(/\r?\n/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
                <Field label="Notes (optional — model sees this)">
                  <textarea
                    className="w-full bg-card border border-border rounded px-2 py-1 text-sm"
                    rows={2}
                    value={c.notes ?? ""}
                    onChange={(e) => update(id, { notes: e.target.value })}
                  />
                </Field>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // The control is nested inside the <label>, which is a valid implicit
    // association per the HTML spec — biome cannot see through `children`.
    // biome-ignore lint/a11y/noLabelWithoutControl: control is nested via children
    <label className="block">
      <span className="text-xs text-muted block mb-1">{label}</span>
      {children}
    </label>
  );
}
