import { api } from "@/lib/api";
import type { MediaItem } from "@api/types";
import { useQuery } from "@tanstack/react-query";

export function useMedia(sessionKey?: string) {
  return useQuery({
    queryKey: ["media", sessionKey ?? "all"],
    queryFn: () =>
      api<{ items: MediaItem[] }>(
        sessionKey ? `/api/media?sessionKey=${encodeURIComponent(sessionKey)}` : "/api/media",
      ),
    refetchInterval: 30_000,
  });
}
