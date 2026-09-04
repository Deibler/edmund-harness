import { api } from "@/lib/api";
import type { CronJobDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useCronJobs(sessionKey?: string) {
  return useQuery({
    queryKey: ["cron", sessionKey ?? "all"],
    queryFn: () =>
      api<{ jobs: CronJobDto[] }>(
        sessionKey ? `/api/cron?sessionKey=${encodeURIComponent(sessionKey)}` : "/api/cron",
      ),
    refetchInterval: 10_000,
  });
}

export function useCancelCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/cron/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron"] }),
  });
}

export function useCreateCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionKey: string; systemEvent: string; schedule: unknown }) =>
      api("/api/cron", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron"] }),
  });
}
