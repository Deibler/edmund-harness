import { Empty, Eyebrow, PageTitle } from "@/components/PageTitle";
import { Tag } from "@/components/Sheet";
import { Input } from "@/components/ui/input";
import type { PortalPageData, SkillGroup } from "@/types";
import { useMemo, useState } from "react";

const GROUPS: Array<{ id: SkillGroup; name: string; blurb: string }> = [
  {
    id: "yours",
    name: "Yours",
    blurb: "Grown out of this conversation. Nobody else sees these unless you share them.",
  },
  {
    id: "public",
    name: "Shared by other people",
    blurb:
      "Written and published by someone else. The first time one comes up, Edmund asks before using it, unless the author is in the chat.",
  },
  {
    id: "curated",
    name: "Learned",
    blurb:
      "Edmund noticed the same job coming up in separate conversations and worked out a method. Written from the shape of the requests, never from anyone's details.",
  },
  { id: "system", name: "Built in", blurb: "The standard kit that ships with Edmund." },
];

export function Skills({ data }: { data: PortalPageData }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle
        ? data.skills.filter((s) =>
            `${s.name} ${s.description} ${s.origin}`.toLowerCase().includes(needle),
          )
        : data.skills,
    [data.skills, needle],
  );

  return (
    <div>
      <PageTitle
        title="Skills"
        lede="The things Edmund has a worked-out method for. You never have to name one. Ask for what you want and he picks. This is here so you can see what is possible, and where each came from."
      />
      {data.skills.length === 0 ? (
        <Empty>Nothing to show yet.</Empty>
      ) : (
        <>
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search skills"
            className="h-11 bg-card text-[15px]"
          />
          {filtered.length === 0 ? <Empty>No matches.</Empty> : null}
          {GROUPS.map((g) => {
            const items = filtered.filter((s) => s.group === g.id);
            if (items.length === 0) return null;
            return (
              <section key={g.id} className="mt-6">
                <Eyebrow>
                  {g.name} · {items.length}
                </Eyebrow>
                <p className="mb-2.5 text-[13.5px] leading-relaxed text-muted-foreground">
                  {g.blurb}
                </p>
                <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
                  {items.map((s) => (
                    <div
                      key={`${g.id}:${s.name}`}
                      className="border-b border-border/70 px-4 py-3 last:border-b-0"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-medium">{s.name}</span>
                        {s.needsConsent ? <Tag>ask Edmund</Tag> : null}
                      </div>
                      <div className="mt-0.5 text-[13.5px] leading-snug text-muted-foreground">
                        {s.origin}
                        {s.description ? ` · ${s.description}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
