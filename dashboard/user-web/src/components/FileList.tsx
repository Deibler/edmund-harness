import { Empty } from "@/components/PageTitle";
import { Input } from "@/components/ui/input";
import { fileUrl } from "@/lib/api";
import { fmtBytes, fmtDay } from "@/lib/format";
import type { PortalFile } from "@/types";
import { DownloadIcon } from "lucide-react";
import { useMemo, useState } from "react";

/** The workspace can hold thousands of vendored files; show the newest slice. */
const MAX_ROWS = 500;

export function FileList({
  files,
  tz,
  emptyText,
  noun,
}: {
  files: PortalFile[];
  tz: string;
  emptyText: string;
  noun: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? files.filter((f) => f.relPath.toLowerCase().includes(needle)) : files;
    return list.slice(0, MAX_ROWS);
  }, [files, q]);
  const truncated = files.length - Math.min(files.length, MAX_ROWS);

  if (files.length === 0) return <Empty>{emptyText}</Empty>;

  return (
    <div>
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${noun}`}
        className="h-11 bg-card text-[15px]"
      />
      {truncated > 0 && !q ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          Showing the newest {MAX_ROWS.toLocaleString()}. {truncated.toLocaleString()} older files
          stay in the workspace.
        </p>
      ) : null}
      <div className="mt-3 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {shown.length === 0 ? (
          <Empty>No matches.</Empty>
        ) : (
          shown.map((f) => (
            <div
              key={f.relPath}
              className="flex items-center gap-3 border-b border-border/70 px-3.5 py-3 last:border-b-0"
            >
              <span className="w-12 shrink-0 rounded-md bg-secondary px-1.5 py-1 text-center text-[10.5px] font-semibold tracking-wide text-muted-foreground">
                {f.ext.replace(".", "").toUpperCase().slice(0, 4) || "FILE"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium">{f.name}</div>
                <div className="truncate text-[12.5px] text-muted-foreground">
                  {f.dir ? `${f.dir} · ` : ""}
                  {fmtBytes(f.sizeBytes)} · {fmtDay(f.mtimeMs, tz)}
                </div>
              </div>
              <a
                href={fileUrl(f.relPath, true)}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label={`Download ${f.name}`}
              >
                <DownloadIcon className="size-4" />
              </a>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
