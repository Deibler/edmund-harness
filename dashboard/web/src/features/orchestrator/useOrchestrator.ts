import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SubsystemKey = "operator" | "ghost" | "people_maintainer" | "trading" | "agents";

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
  source: "custom" | "shared" | "missing";
  size: number;
  mtimeMs: number;
}

/** A named conversation persona — the built-in main one plus every
 *  [[orchestrators]] config entry. */
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

export interface CreateOrchestratorArgs {
  name: string;
  key?: string;
  invocations: string[];
  role: OrchRole;
  model?: string;
  /** Per-file persona choice. Unlisted files inherit the shared persona/
   *  file; IDENTITY.md always scaffolds a custom file unless explicitly
   *  set to shared. */
  persona?: Record<string, { mode: "shared" | "custom" }>;
}

export interface CreateOrchestratorResult {
  ok: boolean;
  key: string;
  scaffolded: string[];
  requiresRestart: boolean;
  persona: OrchPersonaStatus[];
}

export function useCreateOrchestrator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateOrchestratorArgs) =>
      api<CreateOrchestratorResult>(`/api/orchestrator/orchestrators`, {
        method: "POST",
        body: args,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orchestrator"] }),
  });
}

export interface UpdateOrchestratorArgs {
  key: string;
  name?: string;
  invocations?: string[];
  role?: OrchRole;
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

export function useDeleteOrchestrator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api<{ ok: boolean; requiresRestart: boolean }>(
        `/api/orchestrator/orchestrators/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orchestrator"] }),
  });
}

// ─── Per-orchestrator persona files (custom override vs shared) ──────────────

export interface OrchPersonaFileContent {
  file: string;
  source: "custom" | "shared";
  content: string;
  sharedContent: string | null;
}

export function useOrchPersonaFile(key: string | null, file: string | null) {
  return useQuery<OrchPersonaFileContent>({
    queryKey: ["orch-persona", key, file],
    queryFn: () =>
      api(
        `/api/orchestrator/orchestrators/${encodeURIComponent(key ?? "")}/persona/${encodeURIComponent(file ?? "")}`,
      ),
    enabled: Boolean(key && file),
    staleTime: 0,
  });
}

export function useSaveOrchPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { key: string; file: string; content: string }) =>
      api<{ ok: boolean; source: "custom" }>(
        `/api/orchestrator/orchestrators/${encodeURIComponent(args.key)}/persona/${encodeURIComponent(args.file)}`,
        { method: "PUT", body: { content: args.content } },
      ),
    onSuccess: (_d, args) => {
      qc.invalidateQueries({ queryKey: ["orch-persona", args.key, args.file] });
      qc.invalidateQueries({ queryKey: ["orchestrator"] });
    },
  });
}

export function useRevertOrchPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { key: string; file: string }) =>
      api<{ ok: boolean; source: "shared" }>(
        `/api/orchestrator/orchestrators/${encodeURIComponent(args.key)}/persona/${encodeURIComponent(args.file)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_d, args) => {
      qc.invalidateQueries({ queryKey: ["orch-persona", args.key, args.file] });
      qc.invalidateQueries({ queryKey: ["orchestrator"] });
    },
  });
}
