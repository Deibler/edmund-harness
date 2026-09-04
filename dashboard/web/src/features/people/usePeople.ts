import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type PeopleSession = {
  sessionKey: string;
  label: string;
  lastInboundMs: number | null;
  lastMaintainedAtMs: number | null;
};

export type PeopleFile = { name: string; bytes: number; mtimeMs: number };

export function usePeople() {
  return useQuery({
    queryKey: ["people"],
    queryFn: () =>
      api<{
        sessions: PeopleSession[];
        files: PeopleFile[];
        config: Record<string, number | boolean | string>;
        peopleDir: string;
        kickQueued: boolean;
      }>("/api/people"),
    refetchInterval: 30_000,
  });
}

export function useRunMaintainer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionKey?: string) =>
      api("/api/people/run", { method: "POST", body: { sessionKey: sessionKey ?? null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["people"] }),
  });
}
