import { FileList } from "@/components/FileList";
import { PageTitle } from "@/components/PageTitle";
import type { PortalPageData } from "@/types";
import { useMemo } from "react";

export function Artifacts({ data }: { data: PortalPageData }) {
  const arts = useMemo(() => data.files.filter((f) => f.isArtifact), [data.files]);
  return (
    <div>
      <PageTitle
        title="Artifacts"
        lede="Finished things Edmund produced. Documents, write-ups, pages, spreadsheets. The readable results, without the working files around them."
      />
      <FileList
        files={arts}
        tz={data.tz}
        noun="artifacts"
        emptyText="No artifacts yet. Ask Edmund to research or write something up and the result appears here."
      />
    </div>
  );
}
