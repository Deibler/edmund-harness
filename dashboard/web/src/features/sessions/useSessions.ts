import { api } from "@/lib/api";
import type { SessionSummary } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<{ sessions: SessionSummary[] }>("/api/sessions"),
    refetchInterval: 15_000,
  });
}

export function useSession(sessionKey: string | undefined) {
  return useQuery({
    queryKey: ["session", sessionKey],
    queryFn: () =>
      api<{ session: SessionSummary }>(`/api/sessions/${encodeURIComponent(sessionKey!)}`),
    enabled: Boolean(sessionKey),
    refetchInterval: 10_000,
  });
}

export function useResetSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey: string) =>
      api(`/api/sessions/${encodeURIComponent(sessionKey)}/reset`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}
