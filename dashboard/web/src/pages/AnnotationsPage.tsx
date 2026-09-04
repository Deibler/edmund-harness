import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { useAnnotations, useRevokeAnnotation } from "@/features/annotations/useAnnotations";
import { fmtTime, relativeTime } from "@/lib/time";
import type { AnnotationDto } from "@api/types";

const tone: Record<AnnotationDto["status"], "neutral" | "ok" | "warn" | "danger" | "accent"> = {
  pending: "accent",
  answered: "ok",
  used: "ok",
  expired: "neutral",
};

export function AnnotationsPage() {
  const { data, isLoading } = useAnnotations();
  const revoke = useRevokeAnnotation();
  const rows = data?.annotations ?? [];
  return (
    <div>
      <PageHeader
        title="Annotation links"
        description="Single-use /a/<id>/<key> URLs the model texts to a phone so the user can mark up an image. Revoking expires the URL."
      />
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No annotation links recorded yet.</p>
      ) : (
        <Card>
          <CardBody className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Status</Th>
                  <Th>Session</Th>
                  <Th>Instruction</Th>
                  <Th>Created</Th>
                  <Th>Expires</Th>
                  <Th>Tunnel</Th>
                  <Th />
                </Tr>
              </Thead>
              <tbody>
                {rows.map((a) => (
                  <Tr key={a.id}>
                    <Td>
                      <Badge tone={tone[a.status]}>{a.status}</Badge>
                    </Td>
                    <Td className="text-xs">{a.sessionLabel}</Td>
                    <Td className="text-xs max-w-md truncate" title={a.instruction}>
                      {a.instruction || <span className="text-muted">—</span>}
                    </Td>
                    <Td className="text-xs text-muted">{relativeTime(a.createdAtMs)}</Td>
                    <Td className="text-xs text-muted">{fmtTime(a.expiresAtMs)}</Td>
                    <Td className="text-xs">{a.tunnelPid ? <code>{a.tunnelPid}</code> : "—"}</Td>
                    <Td>
                      {a.status === "pending" ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(a.id)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
