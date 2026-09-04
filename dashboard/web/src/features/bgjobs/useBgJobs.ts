import { api } from "@/lib/api";
import type { BgJobDto } from "@api/types";
import { useQuery } from "@tanstack/react-query";

export function useBgJobs(filter?: { sessionKey?: string; status?: string }) {
  const qs = new URLSearchParams();
  if (filter?.sessionKey) qs.set("session", filter.sessionKey);
  if (filter?.status) qs.set("status", filter.status);
  return useQuery({
    queryKey: ["bgjobs", filter?.sessionKey ?? "", filter?.status ?? ""],
    queryFn: () => api<{ jobs: BgJobDto[] }>(`/api/bgjobs?${qs.toString()}`),
    refetchInterval: 5_000,
  });
}

export function useBgJob(id: string | null) {
  return useQuery({
    queryKey: ["bgjob", id],
    enabled: !!id,
    queryFn: () => api<{ job: BgJobDto }>(`/api/bgjobs/${encodeURIComponent(id!)}`),
    refetchInterval: 3_000,
  });
}
