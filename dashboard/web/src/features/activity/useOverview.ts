import { api } from "@/lib/api";
import type { OverviewSnapshot } from "@api/types";
import { useQuery } from "@tanstack/react-query";

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api<OverviewSnapshot>("/api/activity/overview"),
    refetchInterval: 7_000,
  });
}
