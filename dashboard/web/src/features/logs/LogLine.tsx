import { cn } from "@/lib/cn";
import type { LogLine } from "@api/types";

const levelClass: Record<LogLine["level"], string> = {
  debug: "text-muted",
  info: "text-fg",
  warn: "text-warn",
  error: "text-danger",
  plain: "text-muted",
};

export function LogLineRow({ line, style }: { line: LogLine; style?: React.CSSProperties }) {
  const t = new Date(line.ts);
  const hms = `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}`;
  return (
    <div
      style={style}
      className={cn(
        "font-mono text-xs px-4 py-1 border-b border-border/40 whitespace-pre-wrap break-words",
        levelClass[line.level],
      )}
    >
      <span className="text-muted mr-2">{hms}</span>
      {line.tag ? <span className="text-accent mr-2">[{line.tag}]</span> : null}
      {line.text}
    </div>
  );
}
