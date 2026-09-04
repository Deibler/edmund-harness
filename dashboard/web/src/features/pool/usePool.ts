import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type PoolStats = {
  poolSize: number;
  hits: number;
  misses: number;
  rebinds: number;
  deadDiscards: number;
  idleEvictions: number;
  lruEvictions: number;
  enabled: boolean;
  maxWorkers: number;
  windowStartMs: number;
  deaths: Array<{ reason: string; n: number }>;
  workers: Array<{
    sessionKey: string;
    rebindKey: string;
    lastUsedMs: number;
    pid: number | null;
    isDead: boolean;
  }>;
};

export type ResourceStatus = {
  timestampMs: number;
  pressure: "normal" | "soft" | "hard";
  busy: boolean;
  consecutiveHardSamples: number;
  limits: { softBytes: number; hardBytes: number; sustainedSamples: number };
  daemon: { pid: number; rssBytes: number; heapUsedBytes: number; externalBytes: number };
  managed: {
    rssBytes: number;
    processCount: number;
    byKindBytes: Record<string, number>;
    largest: { pid: number; rssBytes: number; command: string } | null;
  };
  action: string | null;
};

export function usePool() {
  return useQuery({
    queryKey: ["pool"],
    queryFn: () =>
      api<{
        stats: PoolStats | null;
        config: Record<string, number | boolean>;
        resources: ResourceStatus | null;
      }>("/api/pool"),
    refetchInterval: 5_000,
  });
}

export function useFlushPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/api/pool/flush", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pool"] }),
  });
}
