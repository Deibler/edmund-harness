import { api } from "@/lib/api";
import type { ContactDto } from "@api/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useContacts() {
  return useQuery({
    queryKey: ["contacts"],
    queryFn: () => api<{ contacts: ContactDto[] }>("/api/contacts"),
  });
}

export function useSaveContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contacts: ContactDto[]) =>
      api<{ ok: boolean; backup: string }>("/api/contacts", {
        method: "PUT",
        body: { contacts },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}
