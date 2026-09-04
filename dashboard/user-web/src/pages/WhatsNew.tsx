import { Empty, PageTitle } from "@/components/PageTitle";
import { fmtDay } from "@/lib/format";
import type { PortalPageData } from "@/types";

export function WhatsNew({ data }: { data: PortalPageData }) {
  return (
    <div>
      <PageTitle title="What's new" lede="Things Edmund has picked up lately." />
      {data.whatsNew.length === 0 ? (
        <Empty>Nothing new right now.</Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {data.whatsNew.map((n, i) => (
            <article
              key={`${n.created_ms}-${i}`}
              className="border-b border-border/70 px-4 py-4 last:border-b-0"
            >
              <div className="text-[12px] text-muted-foreground">
                {fmtDay(n.created_ms, data.tz)}
              </div>
              <h3 className="mt-0.5 text-[1.05rem]">{n.title}</h3>
              <p className="mt-1 text-[14.5px] leading-relaxed text-muted-foreground">{n.body}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
