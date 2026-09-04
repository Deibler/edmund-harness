import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export type MetricsSnapshot = {
  days: number;
  rows: Array<{
    day: string;
    sessionKey: string;
    subsystem: string;
    turns: number;
    costUsd: number;
    durMs: number;
  }>;
  byDay: Array<{ day: string; costUsd: number; turns: number; durMs: number }>;
  bySubsystem: Array<{ subsystem: string; costUsd: number; turns: number; durMs: number }>;
  bySession: Array<{ sessionKey: string; costUsd: number; turns: number }>;
};

export function useMetrics(days = 14) {
  return useQuery({
    queryKey: ["metrics", days],
    queryFn: () => api<MetricsSnapshot>(`/api/metrics?days=${days}`),
    refetchInterval: 60_000,
  });
}
