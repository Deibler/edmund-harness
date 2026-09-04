import { PageHeader } from "@/components/layout/PageHeader";
import { type LogFilter, LogFilters } from "@/features/logs/LogFilters";
import { LogLineRow } from "@/features/logs/LogLine";
import { useLogStream } from "@/features/logs/useLogStream";
import type { LogLine } from "@api/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";

const DEFAULT_LEVELS: LogFilter["levels"] = new Set(["info", "warn", "error", "plain"]);
const ROW_HEIGHT = 40;

export function LogsPage() {
  const { lines, connected, clear } = useLogStream();
  const [filter, setFilter] = useState<LogFilter>({
    levels: DEFAULT_LEVELS,
    query: "",
    tag: "",
  });
  const [follow, setFollow] = useState(true);
  const listRef = useRef<FixedSizeList | null>(null);

  const filtered = useMemo(() => {
    const q = filter.query.toLowerCase();
    const tag = filter.tag.toLowerCase();
    return lines.filter((l) => {
      if (!filter.levels.has(l.level)) return false;
      if (tag && !(l.tag ?? "").toLowerCase().includes(tag)) return false;
      if (q && !l.text.toLowerCase().includes(q) && !(l.tag ?? "").toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [lines, filter]);

  useEffect(() => {
    if (follow && listRef.current) {
      listRef.current.scrollToItem(filtered.length - 1, "end");
    }
  }, [filtered, follow]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && (e.target as HTMLElement).tagName !== "INPUT") {
        e.preventDefault();
        const inp = document.querySelector<HTMLInputElement>('input[placeholder="Search text"]');
        inp?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const Row = ({ index, style }: ListChildComponentProps) => (
    <LogLineRow line={filtered[index] as LogLine} style={style} />
  );

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Logs"
        description="Live tail of data/daemon.log + mcp + agent subprocess streams."
        actions={
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
        }
      />
      <LogFilters
        filter={filter}
        onChange={setFilter}
        onClear={clear}
        connected={connected}
        count={filtered.length}
      />
      <div className="flex-1 bg-card border border-border rounded-lg overflow-hidden">
        <AutoHeight>
          {(h) => (
            <FixedSizeList
              ref={listRef}
              height={h}
              itemCount={filtered.length}
              itemSize={ROW_HEIGHT}
              width="100%"
              onScroll={({ scrollUpdateWasRequested, scrollOffset }) => {
                if (!scrollUpdateWasRequested) {
                  // user-initiated scroll — toggle follow off if they scrolled up
                  const lastTop = Math.max(0, (filtered.length - 1) * ROW_HEIGHT - h + ROW_HEIGHT);
                  if (scrollOffset < lastTop - ROW_HEIGHT * 2) setFollow(false);
                }
              }}
            >
              {Row}
            </FixedSizeList>
          )}
        </AutoHeight>
      </div>
    </div>
  );
}

function AutoHeight({ children }: { children: (h: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(400);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setH(e.contentRect.height);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="h-full w-full">
      {children(h)}
    </div>
  );
}
