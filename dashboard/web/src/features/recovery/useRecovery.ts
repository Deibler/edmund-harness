import { api } from "@/lib/api";
import type { RecoveryRowDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useRecovery() {
  return useQuery({
    queryKey: ["recovery"],
    queryFn: () =>
      api<{
        rows: RecoveryRowDto[];
        config: Record<string, number | boolean>;
        sweepKicked: boolean;
      }>("/api/recovery"),
    refetchInterval: 10_000,
  });
}

export function useRecoverySweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/api/recovery/sweep", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recovery"] }),
  });
}

export function useRecoveryReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey: string) =>
      api(`/api/recovery/${encodeURIComponent(sessionKey)}/reset`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recovery"] }),
  });
}
