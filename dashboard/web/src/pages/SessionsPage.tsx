import { PageHeader } from "@/components/layout/PageHeader";
import { Input } from "@/components/ui/Input";
import { SessionTable } from "@/features/sessions/SessionTable";
import { useSessions } from "@/features/sessions/useSessions";
import { useMemo, useState } from "react";

export function SessionsPage() {
  const { data, isLoading } = useSessions();
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const rows = data?.sessions ?? [];
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter(
      (s) => s.label.toLowerCase().includes(needle) || s.sessionKey.toLowerCase().includes(needle),
    );
  }, [data, q]);
  return (
    <div>
      <PageHeader
        title="Sessions"
        description="Every DM and group the assistant has a session for."
        actions={
          <Input
            placeholder="Filter by name or handle"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-64"
          />
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <SessionTable sessions={filtered} />
      )}
    </div>
  );
}
