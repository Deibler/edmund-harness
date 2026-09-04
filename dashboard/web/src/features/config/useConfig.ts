import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type ConfigResponse = { config: Record<string, unknown> };

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
    staleTime: 30_000,
  });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api<{ ok: boolean; backup: string }>("/api/config", { method: "PUT", body: { config } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });
}
