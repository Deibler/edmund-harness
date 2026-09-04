import { api } from "@/lib/api";
import type { ChatLine } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useHistory(sessionKey: string | undefined) {
  return useQuery({
    queryKey: ["history", sessionKey],
    queryFn: () =>
      api<{ lines: ChatLine[] }>(`/api/messages/${encodeURIComponent(sessionKey!)}/history`),
    enabled: Boolean(sessionKey),
    refetchInterval: 20_000,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionKey, text }: { sessionKey: string; text: string }) =>
      api(`/api/messages/${encodeURIComponent(sessionKey)}/send`, {
        method: "POST",
        body: { text },
      }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["history", v.sessionKey] }),
  });
}
