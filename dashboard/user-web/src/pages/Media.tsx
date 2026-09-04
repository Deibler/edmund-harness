import { Empty, PageTitle } from "@/components/PageTitle";
import { Input } from "@/components/ui/input";
import { fileUrl } from "@/lib/api";
import { fmtBytes, fmtDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PortalMediaItem, PortalPageData } from "@/types";
import { useMemo, useState } from "react";

type Filter = "all" | "image" | "video" | "audio" | "other" | "generated" | "received";

const FILTERS: Array<{ id: Filter; name: string }> = [
  { id: "all", name: "All" },
  { id: "image", name: "Images" },
  { id: "video", name: "Videos" },
  { id: "audio", name: "Voice" },
  { id: "other", name: "Other" },
  { id: "generated", name: "Made by Edmund" },
  { id: "received", name: "Sent to him" },
];

export function Media({ data }: { data: PortalPageData }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.media.filter((m) => {
      if (needle && !`${m.name} ${m.kind} ${m.direction}`.toLowerCase().includes(needle))
        return false;
      if (filter === "all") return true;
      if (filter === "generated" || filter === "received") return m.direction === filter;
      return m.kind === filter;
    });
  }, [data.media, q, filter]);

  const you = data.isGroup ? "the group" : "you";

  return (
    <div>
      <PageTitle
        title="Media"
        lede={`Every photo, video and voice memo from this conversation. Things Edmund made for ${you}, and things ${data.isGroup ? "members" : "you"} sent him. Tap an image to open it full size.`}
      />

      {data.media.length === 0 ? (
        <Empty>
          Nothing yet. Ask Edmund for an image, a video or a voice memo and it lands here.
        </Empty>
      ) : (
        <>
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name"
            className="h-11 bg-card text-[15px]"
          />
          <div className="my-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors",
                  filter === f.id
                    ? "border-ink bg-ink text-paper"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {f.name}
              </button>
            ))}
          </div>
          {items.length === 0 ? (
            <Empty>No matches.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {items.map((m) => (
                <Tile key={m.rel} item={m} tz={data.tz} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ item: m, tz }: { item: PortalMediaItem; tz: string }) {
  const url = fileUrl(m.rel);
  const meta = `${m.direction === "generated" ? "Edmund" : "Sent in"} · ${fmtDay(m.mtimeMs, tz)} · ${fmtBytes(m.sizeBytes)}`;
  const frame = "overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10";
  const caption = (
    <div className="truncate px-2.5 py-2 text-[11.5px] text-muted-foreground">{meta}</div>
  );

  if (m.kind === "image") {
    return (
      <a className={frame} href={url} target="_blank" rel="noreferrer noopener">
        <img
          loading="lazy"
          src={url}
          alt={m.name}
          className="aspect-square w-full object-cover bg-muted"
        />
        {caption}
      </a>
    );
  }
  if (m.kind === "video") {
    return (
      <div className={frame}>
        {/* biome-ignore lint/a11y/useMediaCaption: people's own clips carry no caption track */}
        <video
          preload="none"
          controls
          playsInline
          src={url}
          className="aspect-square w-full bg-ink object-cover"
        />
        {caption}
      </div>
    );
  }
  if (m.kind === "audio") {
    return (
      <div className={cn(frame, "col-span-2 sm:col-span-3 p-3")}>
        <div className="truncate text-[14px] font-medium">{m.name}</div>
        {/* biome-ignore lint/a11y/useMediaCaption: voice memos carry no caption track */}
        <audio preload="none" controls src={url} className="mt-2 w-full" />
        <div className="mt-1 text-[12px] text-muted-foreground">{meta}</div>
      </div>
    );
  }
  return (
    <a className={cn(frame, "col-span-2 sm:col-span-3 p-3")} href={fileUrl(m.rel, true)}>
      <div className="truncate text-[14px] font-medium">{m.name}</div>
      <div className="mt-1 text-[12px] text-muted-foreground">{meta} · tap to download</div>
    </a>
  );
}
