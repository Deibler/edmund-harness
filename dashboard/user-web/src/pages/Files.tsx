import { FileList } from "@/components/FileList";
import { PageTitle } from "@/components/PageTitle";
import type { PortalPageData } from "@/types";

export function Files({ data }: { data: PortalPageData }) {
  const you = data.isGroup ? "the group" : "you";
  return (
    <div>
      <PageTitle
        title="Files"
        lede={`Edmund's private workspace for this conversation. Every working file he has created or saved while helping ${you}. Photos and videos live under Media.`}
      />
      <FileList
        files={data.files}
        tz={data.tz}
        noun="files"
        emptyText={`No files yet. When Edmund works on something for ${you}, it lands here.`}
      />
    </div>
  );
}
