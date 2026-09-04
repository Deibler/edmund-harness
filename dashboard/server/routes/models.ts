import { Hono } from "hono";

// 2-minute in-memory cache to avoid hammering OpenRouter
let modelCache: { data: ORModel[]; fetchedAt: number } | null = null;
const CACHE_TTL = 2 * 60 * 1000;

interface ORModel {
  id: string;
  name: string;
  created: number;
  description: string;
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
  };
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    input_cache_read?: string;
  };
  supported_parameters: string[];
  top_provider?: {
    context_length: number | null;
    max_completion_tokens: number | null;
    is_moderated: boolean;
  };
}

async function fetchModels(): Promise<ORModel[]> {
  const now = Date.now();
  if (modelCache && now - modelCache.fetchedAt < CACHE_TTL) return modelCache.data;
  const resp = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`OpenRouter API ${resp.status}`);
  const json = (await resp.json()) as { data: ORModel[] };
  modelCache = { data: json.data, fetchedAt: now };
  return json.data;
}

export function modelsRoutes(): Hono {
  const app = new Hono();

  // GET / → OpenRouter catalog used by media/audio configuration screens.
  app.get("/", async (c) => {
    try {
      return c.json({ models: await fetchModels() });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}
