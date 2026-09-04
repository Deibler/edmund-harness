import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { LogLine } from "@api/types";

export type LogFilter = {
  levels: Set<LogLine["level"]>;
  query: string;
  tag: string;
};

const ALL_LEVELS: Array<LogLine["level"]> = ["debug", "info", "warn", "error", "plain"];

export function LogFilters({
  filter,
  onChange,
  onClear,
  connected,
  count,
}: {
  filter: LogFilter;
  onChange: (f: LogFilter) => void;
  onClear: () => void;
  connected: boolean;
  count: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <div className="flex gap-1">
        {ALL_LEVELS.map((lvl) => {
          const active = filter.levels.has(lvl);
          return (
            <Button
              key={lvl}
              size="sm"
              variant={active ? "primary" : "secondary"}
              onClick={() => {
                const next = new Set(filter.levels);
                if (active) next.delete(lvl);
                else next.add(lvl);
                onChange({ ...filter, levels: next });
              }}
            >
              {lvl}
            </Button>
          );
        })}
      </div>
      <Input
        placeholder="Filter tag (claude, mcp, agent, dash, sched, …)"
        className="w-64"
        value={filter.tag}
        onChange={(e) => onChange({ ...filter, tag: e.target.value })}
      />
      <Input
        placeholder="Search text"
        className="flex-1 min-w-[12rem]"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
      />
      <span className="text-xs text-muted">
        {count} lines · {connected ? "live" : "reconnecting…"}
      </span>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
