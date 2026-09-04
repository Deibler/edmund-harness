import { api } from "@/lib/api";
import type { CreditsOverviewDto, LiabilityDto, WalletDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const KEY = ["credits"];

/** Every fetch is a live read of OpenRouter + Stripe on the server. */
export function useCredits() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<CreditsOverviewDto>("/api/credits"),
    refetchInterval: 60_000,
    staleTime: 0,
  });
}

export function useRefreshCredits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CreditsOverviewDto>("/api/credits/refresh", { method: "POST" }),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}

export function useSetBillingMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { sessionKey?: string; handle?: string; mode: "wallet" | "house" }) =>
      api<{ wallet: WalletDto }>("/api/credits/mode", { method: "POST", body: args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useGrantCredit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { sessionKey: string; usd: number }) =>
      api<{ wallet: WalletDto; limitUsd: number | null }>("/api/credits/grant", {
        method: "POST",
        body: args,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSyncWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey: string) =>
      api<{ raised: boolean; raisedByUsd: number; wallet: WalletDto }>("/api/credits/sync", {
        method: "POST",
        body: { sessionKey },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSetWalletDisabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { sessionKey: string; disabled: boolean }) =>
      api<{ wallet: WalletDto }>("/api/credits/disabled", { method: "POST", body: args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Live check against OpenRouter — one call per wallet, so on demand only. */
export function useLiability() {
  return useMutation({
    mutationFn: () => api<LiabilityDto>("/api/credits/liability"),
  });
}
