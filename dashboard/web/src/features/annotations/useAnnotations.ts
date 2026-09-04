import { api } from "@/lib/api";
import type { AnnotationDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useAnnotations() {
  return useQuery({
    queryKey: ["annotations"],
    queryFn: () => api<{ annotations: AnnotationDto[] }>("/api/annotations"),
    refetchInterval: 10_000,
  });
}

export function useRevokeAnnotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/api/annotations/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["annotations"] }),
  });
}
