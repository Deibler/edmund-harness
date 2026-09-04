import { Empty, PageTitle } from "@/components/PageTitle";
import { renderMarkdown } from "@/lib/markdown";
import type { PortalPageData } from "@/types";
import { useMemo } from "react";

export function Memory({ data }: { data: PortalPageData }) {
  const nodes = useMemo(
    () => (data.personBody ? renderMarkdown(data.personBody.slice(0, 40_000)) : null),
    [data.personBody],
  );
  return (
    <div>
      <PageTitle
        title="Memory"
        lede="Edmund keeps a private notes file about each person he talks to. Preferences, context, things you told him to remember. This is yours, in full. It is read-only here: to change or forget something, tell him in Messages, or erase it under Privacy."
      />
      {nodes ? (
        <article className="memo rounded-xl bg-card px-5 py-6 ring-1 ring-foreground/10 sm:px-7 sm:py-8">
          {nodes}
        </article>
      ) : (
        <Empty>No notes yet. He builds this up as you talk.</Empty>
      )}
    </div>
  );
}
