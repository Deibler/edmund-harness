import { api } from "@/lib/api";
import type { AgentDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useAgents(filter?: {
  sessionKey?: string;
  status?: AgentDto["status"];
  teamId?: string;
}) {
  const qs = new URLSearchParams();
  if (filter?.sessionKey) qs.set("sessionKey", filter.sessionKey);
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.teamId) qs.set("teamId", filter.teamId);
  const key = ["agents", filter?.sessionKey ?? "", filter?.status ?? "", filter?.teamId ?? ""];
  return useQuery({
    queryKey: key,
    queryFn: () => api<{ agents: AgentDto[] }>(`/api/agents?${qs.toString()}`),
    refetchInterval: 5_000,
  });
}

export function useAgentResult(id: string | undefined) {
  return useQuery({
    queryKey: ["agent-result", id],
    queryFn: () => api<{ text: string }>(`/api/agents/${id}/result`),
    enabled: Boolean(id),
  });
}

export function useAgentLog(id: string | undefined) {
  return useQuery({
    queryKey: ["agent-log", id],
    queryFn: () => api<{ text: string }>(`/api/agents/${id}/log`),
    enabled: Boolean(id),
    refetchInterval: 4_000,
  });
}

export function useCancelAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/agents/${id}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}
