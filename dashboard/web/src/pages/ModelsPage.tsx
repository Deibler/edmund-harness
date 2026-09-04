import { PageHeader } from "@/components/layout/PageHeader";
import { ModelBrowser } from "@/components/models/ModelBrowser";
import { useModels } from "@/features/models/useModels";

export function ModelsPage() {
  const { data, isLoading } = useModels();

  const models = data?.models ?? [];

  return (
    <div>
      <PageHeader
        title="Models"
        description={`${models.length} OpenRouter models available to image, video, and audio tools`}
      />

      <ModelBrowser models={models} isLoading={isLoading} />
    </div>
  );
}
