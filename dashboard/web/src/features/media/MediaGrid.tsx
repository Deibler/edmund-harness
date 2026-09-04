import { Badge } from "@/components/ui/Badge";
import { fmtTime } from "@/lib/time";
import type { MediaItem } from "@api/types";

function formatSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

export function MediaGrid({ items }: { items: MediaItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">No media in the sandbox yet.</p>;
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {items.map((item) => (
        <a
          key={item.path}
          href={item.relativeUrl}
          target="_blank"
          rel="noreferrer"
          className="group rounded-lg border border-border bg-card overflow-hidden hover:border-accent/60 transition-colors"
        >
          <div className="aspect-square bg-bg flex items-center justify-center overflow-hidden">
            {item.kind === "image" ? (
              <img
                src={item.relativeUrl}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : item.kind === "video" ? (
              <video src={item.relativeUrl} className="w-full h-full object-cover" muted />
            ) : (
              <span className="text-muted text-3xl">{item.kind === "audio" ? "♪" : "⌗"}</span>
            )}
          </div>
          <div className="p-2">
            <div className="flex items-center gap-1 mb-1">
              <Badge tone={item.direction === "generated" ? "accent" : "neutral"}>
                {item.direction}
              </Badge>
              <Badge>{item.kind}</Badge>
            </div>
            <div className="text-[11px] text-muted truncate" title={item.path}>
              {item.sessionLabel}
            </div>
            <div className="text-[10px] text-muted/70 mt-0.5">
              {fmtTime(item.mtimeMs)} · {formatSize(item.sizeBytes)}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
