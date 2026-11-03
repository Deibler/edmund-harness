import { Empty, Eyebrow, PageTitle } from "@/components/PageTitle";
import { Paper, Row } from "@/components/Sheet";
import { fmtDateShort, plural } from "@/lib/format";
import type { PortalPageData } from "@/types";
import { ArrowUpRightIcon } from "lucide-react";

/**
 * Pages Edmund built, unasked, for something this person keeps coming back
 * to (src/ideation/), newest first, and the interests behind them. Nothing
 * here asks anything of them: each page was already sent in their texts.
 */
export function Ideas({ data }: { data: PortalPageData }) {
  // A bundle rebuilt ahead of a server restart meets page data without this
  // field; that must read as "nothing yet", not take the portal down.
  const { pages, threads } = data.ideas ?? { pages: [], threads: [] };
  return (
    <div>
      <PageTitle
        title="Made for you"
        lede="When something keeps coming up in your texts, Edmund builds you a page for it: a thing to explore and come back to, not another message."
      />

      {pages.length === 0 ? (
        <Empty>
          Nothing yet. When a subject comes up again and again, the page Edmund builds for it will
          appear here.
        </Empty>
      ) : (
        <ol className="mb-8 space-y-4">
          {pages.map((p) => (
            <li key={p.url}>
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="group block overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 transition-colors hover:ring-foreground/25"
              >
                <img
                  src={p.thumbUrl}
                  alt=""
                  loading="lazy"
                  className="aspect-[16/10] w-full border-b border-border/70 object-cover object-top"
                />
                <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[1.1rem] leading-snug font-heading">{p.title}</div>
                    <p className="mt-1 text-[14.5px] leading-relaxed text-muted-foreground">
                      {p.pitch}
                    </p>
                    <p className="mt-2 text-[13px] text-muted-foreground">
                      {fmtDateShort(p.readyMs, data.tz)} · from your questions about {p.thread}, on{" "}
                      {plural(p.days, "day")}
                    </p>
                  </div>
                  <ArrowUpRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground" />
                </div>
              </a>
            </li>
          ))}
        </ol>
      )}

      {threads.length > 0 ? (
        <>
          <Eyebrow>What you keep coming back to</Eyebrow>
          <Paper>
            {threads.map((t) => (
              <Row
                key={t.label}
                right={
                  <span className="tnum text-[13px] text-muted-foreground">
                    {plural(t.days, "day")} · last {fmtDateShort(t.lastSeenMs, data.tz)}
                  </span>
                }
              >
                <span className="text-[15px]">{t.label}</span>
              </Row>
            ))}
          </Paper>
        </>
      ) : null}

      <p className="mt-4 text-[13.5px] leading-relaxed text-muted-foreground">
        A page is made once a subject comes up on three or more separate days, at most one a week.
        Health, money, legal and private matters are never turned into pages. Erasing everything on
        the Privacy page removes these too.
      </p>
    </div>
  );
}
