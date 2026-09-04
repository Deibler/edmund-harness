import { api } from "@/lib/api";
import type { AlertDto, AlertMuteDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: () => api<{ alerts: AlertDto[]; mutes: AlertMuteDto[] }>("/api/alerts"),
    refetchInterval: 15_000,
  });
}

export function useMuteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { category: string; minutes: number }) =>
      api("/api/alerts/mute", { method: "POST", body: args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useUnmuteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (category: string) =>
      api("/api/alerts/unmute", { method: "POST", body: { category } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}
