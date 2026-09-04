import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export interface ORModel {
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
    is_moderated: boolean;
  };
}

export interface ModelsResponse {
  models: ORModel[];
}

export function useModels() {
  return useQuery<ModelsResponse>({
    queryKey: ["models"],
    queryFn: () => api<ModelsResponse>("/api/models"),
    refetchInterval: 30_000,
    staleTime: 60_000,
  });
}

// ─── Derived helpers ──────────────────────────────────────────────────────────

export function labFromId(id: string): string {
  return id.split("/")[0] ?? id;
}

export function labDisplayName(lab: string): string {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    google: "Google",
    openai: "OpenAI",
    meta: "Meta",
    "meta-llama": "Meta",
    mistralai: "Mistral",
    deepseek: "DeepSeek",
    "x-ai": "xAI",
    cohere: "Cohere",
    amazon: "Amazon",
    microsoft: "Microsoft",
    nvidia: "NVIDIA",
    qwen: "Qwen/Alibaba",
    moonshotai: "Moonshot",
    "01-ai": "01.AI",
    inflection: "Inflection",
    "perplexity-ai": "Perplexity",
    nousresearch: "Nous",
    gryphe: "Gryphe",
    "cognitive-computations": "Cognitive",
    cognitivecomputations: "Cognitive",
    databricks: "Databricks",
    ai21: "AI21",
    allenai: "AllenAI",
    bytedance: "ByteDance",
    "bytedance-seed": "ByteDance",
    tencent: "Tencent",
    baidu: "Baidu",
    ibm: "IBM",
    "ibm-granite": "IBM",
  };
  return names[lab] ?? lab.charAt(0).toUpperCase() + lab.slice(1);
}

export function fmtPrice(raw: string): string {
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0) return "Varies";
  if (n === 0) return "FREE";
  const per_m = n * 1_000_000;
  if (per_m < 0.001) return `$${(per_m * 1000).toFixed(3)}/B`;
  if (per_m < 1) return `$${per_m.toFixed(3)}/M`;
  return `$${per_m.toFixed(2)}/M`;
}

export function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function getInputModalities(m: ORModel): string[] {
  return m.architecture?.input_modalities ?? [];
}

export function supportsTools(m: ORModel): boolean {
  return m.supported_parameters?.includes("tools") ?? false;
}

export function isFree(m: ORModel): boolean {
  const p = Number.parseFloat(m.pricing?.prompt ?? "0");
  const c = Number.parseFloat(m.pricing?.completion ?? "0");
  return p === 0 && c === 0 && !Number.isNaN(p) && !Number.isNaN(c);
}

export function modelDate(m: ORModel): string {
  if (!m.created) return "";
  return new Date(m.created * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function inputPriceNum(m: ORModel): number {
  return Number.parseFloat(m.pricing?.prompt ?? "0");
}

export function outputPriceNum(m: ORModel): number {
  return Number.parseFloat(m.pricing?.completion ?? "0");
}
