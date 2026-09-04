import { Eyebrow, Stat } from "@/components/PageTitle";
import { Paper } from "@/components/Sheet";
import { type TabId, visibleTabs } from "@/tabs";
import type { PortalPageData } from "@/types";
import { ChevronRightIcon } from "lucide-react";

export function Home({ data, go }: { data: PortalPageData; go: (id: TabId) => void }) {
  const a = data.analytics;
  const sections = visibleTabs({ isGroup: data.isGroup, hasCredits: data.credits !== null }).filter(
    (t) => t.id !== "home",
  );
  const you = data.isGroup ? "this group" : "you";

  return (
    <div>
      <div className="mb-7">
        <Eyebrow>{data.isGroup ? "Group" : "Personal page"}</Eyebrow>
        <h1 className="text-[2rem] leading-[1.1] sm:text-[2.35rem]">{data.label}</h1>
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-muted-foreground">
          Everything Edmund keeps and does for this one conversation. Settings, what he has made,
          what he remembers, and the controls to change or delete any of it. Nothing from any other
          chat appears here.
        </p>
        {data.isGroup && data.members.length > 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            In this group: {data.members.join(", ")}
          </p>
        ) : null}
      </div>

      <div className="mb-8 grid grid-cols-3 gap-2.5">
        <Stat
          value={a.messages.total.toLocaleString()}
          label="messages"
          onClick={() => go("analytics")}
        />
        <Stat
          value={(a.media.images + a.media.videos + a.media.audio).toLocaleString()}
          label="media items"
          onClick={() => go("media")}
        />
        <Stat value={a.schedules.active} label="schedules" onClick={() => go("schedules")} />
      </div>

      <Eyebrow>Sections</Eyebrow>
      <nav className="mb-8 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {sections.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            className="flex w-full items-center gap-3 border-b border-border/70 px-4 py-3.5 text-left transition-colors last:border-b-0 hover:bg-secondary/50 active:bg-secondary"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium">{t.name}</span>
              <span className="block text-[13.5px] leading-snug text-muted-foreground">
                {t.desc}
              </span>
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
          </button>
        ))}
      </nav>

      <Paper title="About Edmund">
        <p className="text-[15px] leading-relaxed">
          Edmund is the assistant in {data.isGroup ? "this group's" : "your"} texts. Ask him
          anything. Send photos, documents and voice memos. Have him research, build, schedule and
          remember. He can also reach out on his own when he has something worth saying, and that is
          entirely under {you} on the Proactive page.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
          House rules for unprompted messages: never a second one while the first sits unanswered,
          only inside the hours you allow, and never on a schedule you could set a watch by.
        </p>
      </Paper>
    </div>
  );
}
