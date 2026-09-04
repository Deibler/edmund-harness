import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { SectionForm } from "@/features/config/SectionForm";
import { SECTIONS, type Section } from "@/features/config/fields";
import { useConfig, useSaveConfig } from "@/features/config/useConfig";
import { Navigate, useParams } from "react-router-dom";

/**
 * Renders one settings section, driven by the `:section` URL param. The
 * sidebar lists every section as its own nav entry — the old tab strip
 * is gone. Selecting a section in the nav routes to /settings/:key.
 */
export function SettingsPage() {
  const { section: key } = useParams();
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return <Navigate to={`/settings/${SECTIONS[0].key}`} replace />;
  return <SectionEditor section={section} />;
}

function SectionEditor({ section }: { section: Section }) {
  const { data, isLoading } = useConfig();
  const save = useSaveConfig();
  const toast = useToast();

  function getAtPath(root: Record<string, unknown>, path: string): Record<string, unknown> {
    const parts = path.split(".");
    let cur: unknown = root;
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return {};
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur && typeof cur === "object" ? (cur as Record<string, unknown>) : {};
  }

  function setAtPath(
    root: Record<string, unknown>,
    path: string,
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    const parts = path.split(".");
    const out: Record<string, unknown> = { ...root };
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      const child = cur[k];
      cur[k] =
        child && typeof child === "object" && !Array.isArray(child)
          ? { ...(child as Record<string, unknown>) }
          : {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
    return out;
  }

  async function persist(next: Record<string, unknown>) {
    if (!data?.config) return;
    const cfg = data.config as Record<string, unknown>;
    const merged = setAtPath(cfg, section.path ?? section.key, next);
    try {
      const res = await save.mutateAsync(merged);
      toast.push({ tone: "ok", title: "Saved", description: `backup: ${res.backup}` });
    } catch (e) {
      toast.push({ tone: "danger", title: "Save failed", description: (e as Error).message });
    }
  }

  const values = data?.config
    ? getAtPath(data.config as Record<string, unknown>, section.path ?? section.key)
    : {};

  return (
    <div>
      <PageHeader
        title={section.label}
        description={
          section.description ??
          "Edits config.toml. A dated backup is written on every save. Daemon must restart to pick up changes."
        }
      />
      {isLoading || !data?.config ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <Card>
          <CardHeader title={section.label} subtitle={section.description} />
          <CardBody>
            <SectionForm
              section={section}
              values={values}
              saving={save.isPending}
              onSave={persist}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
