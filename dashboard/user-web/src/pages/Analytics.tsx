import { PageTitle, Stat } from "@/components/PageTitle";
import { Paper } from "@/components/Sheet";
import { fmtBytes, fmtDay } from "@/lib/format";
import type { PortalPageData } from "@/types";

export function Analytics({ data }: { data: PortalPageData }) {
  const a = data.analytics;
  const rate =
    a.proactive.total > 0 ? `${Math.round((a.proactive.engaged / a.proactive.total) * 100)}%` : "—";
  const grid = "grid grid-cols-2 gap-2.5 sm:grid-cols-3";
  const small = (s: string) => <span className="text-[1.05rem]">{s}</span>;

  return (
    <div>
      <PageTitle
        title="Analytics"
        lede={`${data.isGroup ? "This group's" : "Your"} numbers with Edmund, computed live from this conversation only.`}
      />

      <Paper title="Messages" padded={false}>
        <div className={`${grid} p-4 sm:p-5`}>
          <Stat value={a.messages.total.toLocaleString()} label="total" />
          <Stat
            value={a.messages.fromYou.toLocaleString()}
            label={`from ${data.isGroup ? "the group" : "you"}`}
          />
          <Stat value={a.messages.fromEdmund.toLocaleString()} label="from Edmund" />
          <Stat
            value={(a.messages.last7.fromYou + a.messages.last7.fromEdmund).toLocaleString()}
            label="last 7 days"
          />
          <Stat
            value={(a.messages.last30.fromYou + a.messages.last30.fromEdmund).toLocaleString()}
            label="last 30 days"
          />
          <Stat value={small(fmtDay(a.messages.firstMs, data.tz))} label="talking since" />
        </div>
      </Paper>

      <Paper
        title="Proactive messages"
        description="Times Edmund reached out on his own, and how they landed."
        padded={false}
      >
        <div className={`${grid} p-4 sm:p-5`}>
          <Stat value={a.proactive.total} label="sent" />
          <Stat
            value={a.proactive.engaged}
            label={data.isGroup ? "someone replied" : "you replied"}
          />
          <Stat value={rate} label="reply rate" />
          <Stat value={small(fmtDay(a.proactive.lastFireMs, data.tz))} label="most recent" />
        </div>
      </Paper>

      <Paper title="Workspace" padded={false}>
        <div className={`${grid} p-4 sm:p-5`}>
          <Stat value={a.media.images} label="images" />
          <Stat value={a.media.videos} label="videos" />
          <Stat value={a.media.audio} label="voice memos" />
          <Stat value={a.files.count} label={`files, ${fmtBytes(a.files.bytes)}`} />
          <Stat value={a.files.artifacts} label="artifacts" />
          <Stat
            value={a.schedules.active}
            label={`schedules${a.schedules.paused ? `, ${a.schedules.paused} paused` : ""}`}
          />
        </div>
      </Paper>
    </div>
  );
}
