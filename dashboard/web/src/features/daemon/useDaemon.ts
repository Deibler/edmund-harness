import { api } from "@/lib/api";
import type { DaemonStatus } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useDaemonStatus() {
  return useQuery({
    queryKey: ["daemon"],
    queryFn: () => api<{ status: DaemonStatus }>("/api/daemon/status"),
    refetchInterval: 5_000,
  });
}

export function useDaemonControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cmd: "start" | "stop" | "restart") =>
      api<{ ok: boolean; output: string }>(`/api/daemon/${cmd}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["daemon"] }),
  });
}

export function useSetDebug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (state: "on" | "off") =>
      api<{ ok: boolean; output: string }>(`/api/daemon/debug/${state}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["daemon"] }),
  });
}
