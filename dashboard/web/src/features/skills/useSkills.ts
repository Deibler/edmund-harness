import { api } from "@/lib/api";
import type { SkillDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SkillsConfig = {
  enabled: boolean;
  allowedSources: string[];
  requireApprovalForScripts: boolean;
  installedDbPath: string;
  skillsRoot: string;
};

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => api<{ skills: SkillDto[]; config: SkillsConfig }>("/api/skills"),
    refetchInterval: 30_000,
  });
}

export function useApproveSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api(`/api/skills/${encodeURIComponent(name)}/approve`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

export function useSetSkillDisabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, disabled }: { name: string; disabled: boolean }) =>
      api(`/api/skills/${encodeURIComponent(name)}/disable`, {
        method: "POST",
        body: { disabled },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

export function useUninstallSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}
