import { api } from "@/lib/api";
import type { RecallCoverage } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type RecallSnapshot = {
  coverage: RecallCoverage | null;
  config: Record<string, unknown>;
  ready: boolean;
  dbPath?: string;
  watermarkMsgRowId?: number;
};

export function useRecall() {
  return useQuery({
    queryKey: ["recall"],
    queryFn: () => api<RecallSnapshot>("/api/recall"),
    refetchInterval: 15_000,
  });
}

export function useRecallReindex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ kicked: boolean }>("/api/recall/reindex", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recall"] }),
  });
}

export function useRecallBySession() {
  return useQuery({
    queryKey: ["recall", "by-session"],
    queryFn: () =>
      api<{ rows: Array<{ chat_guid: string; n: number; last_ts: number }> }>(
        "/api/recall/by-session",
      ),
    refetchInterval: 60_000,
  });
}
