import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SubsystemKey = "operator" | "ghost" | "people_maintainer" | "agents";

export interface OrchSubsystem {
  key: SubsystemKey;
  label: string;
  description: string;
  personaFiles: string[];
  model: string;
  effectiveModel: string;
  inheritsOperator: boolean;
}

export interface PersonaFileInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

export type OrchRole = "primary" | "secondary";

export interface OrchPersonaStatus {
  file: string;
  source: "shared" | "missing";
  size: number;
  mtimeMs: number;
}

/** The conversation persona, as the settings page lists it. */
export interface NamedOrchestrator {
  key: string;
  name: string;
  invocations: string[];
  role: OrchRole;
  builtin: boolean;
  model: string;
  effectiveModel: string;
  inheritsOperator: boolean;
  persona: OrchPersonaStatus[];
}

export interface OrchestratorResponse {
  subsystems: OrchSubsystem[];
  orchestrators: NamedOrchestrator[];
  compact: { enabled: boolean; threshold_tokens: number };
  effort: string;
  personaFiles: PersonaFileInfo[];
}

export function useOrchestrator() {
  return useQuery<OrchestratorResponse>({
    queryKey: ["orchestrator"],
    queryFn: () => api<OrchestratorResponse>("/api/orchestrator"),
    refetchInterval: 15_000,
  });
}

export function useUpdateSubsystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { key: SubsystemKey; model: string }) =>
      api<{ ok: boolean }>(`/api/orchestrator/subsystem/${args.key}`, {
        method: "PUT",
        body: { model: args.model },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orchestrator"] });
    },
  });
}

export function usePersonaFile(name: string | null) {
  return useQuery<{ name: string; content: string }>({
    queryKey: ["persona-file", name],
    queryFn: () => api(`/api/orchestrator/persona/${encodeURIComponent(name ?? "")}`),
    enabled: Boolean(name),
    staleTime: 0,
  });
}

export function useSavePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; content: string }) =>
      api<{ ok: boolean }>(`/api/orchestrator/persona/${encodeURIComponent(args.name)}`, {
        method: "PUT",
        body: { content: args.content },
      }),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["persona-file", args.name] });
      qc.invalidateQueries({ queryKey: ["orchestrator"] });
    },
  });
}

// ─── Named-orchestrator CRUD ─────────────────────────────────────────────────

export interface UpdateOrchestratorArgs {
  key: string;
  invocations?: string[];
  model?: string;
}

export function useUpdateOrchestrator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...body }: UpdateOrchestratorArgs) =>
      api<{ ok: boolean; requiresRestart: boolean }>(
        `/api/orchestrator/orchestrators/${encodeURIComponent(key)}`,
        { method: "PUT", body },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orchestrator"] }),
  });
}

// ─── Per-orchestrator persona files (custom override vs shared) ──────────────
