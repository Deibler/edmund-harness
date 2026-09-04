import { PageHeader } from "@/components/layout/PageHeader";
import { MediaGrid } from "@/features/media/MediaGrid";
import { useMedia } from "@/features/media/useMedia";

export function MediaPage() {
  const { data, isLoading } = useMedia();
  return (
    <div>
      <PageHeader
        title="Media"
        description="Everything the assistant has generated or received, across every session."
      />
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <MediaGrid items={data?.items ?? []} />
      )}
    </div>
  );
}
