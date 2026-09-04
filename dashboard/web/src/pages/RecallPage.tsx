import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Table, Td, Th, Thead, Tr } from "@/components/ui/Table";
import { useRecall, useRecallBySession, useRecallReindex } from "@/features/recall/useRecall";
import { fmtTime, relativeTime } from "@/lib/time";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function RecallPage() {
  const { data, isLoading } = useRecall();
  const bySession = useRecallBySession();
  const reindex = useRecallReindex();
  const cov = data?.coverage;
  return (
    <div>
      <PageHeader
        title="Recall / index"
        description="Embedding index that backs semantic_search and the auto-recall envelope block."
        actions={
          <Button
            variant="primary"
            disabled={reindex.isPending || cov?.reindexing}
            onClick={() => reindex.mutate()}
          >
            {cov?.reindexing ? "Reindex queued…" : "Kick reindex"}
          </Button>
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !data?.ready || !cov ? (
        <Card>
          <CardBody className="text-sm text-muted">
            Index not built yet — the daemon will create{" "}
            <code>
              {(data?.config as { index_db?: string } | undefined)?.index_db ?? "vector.db"}
            </code>{" "}
            on first tick.
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat label="Messages" value={cov.indexedMsgs.toLocaleString()} />
            <Stat label="Artifacts" value={cov.indexedArtifacts.toLocaleString()} />
            <Stat label="People" value={`${cov.indexedPeople} / ${cov.totalPeople}`} />
            <Stat label="DB size" value={bytes(cov.dbBytes)} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Index state" />
            <CardBody className="text-sm space-y-1">
              <div>
                <span className="text-muted">Last write: </span>
                {cov.lastIndexedAtMs ? (
                  <span title={fmtTime(cov.lastIndexedAtMs)}>
                    {relativeTime(cov.lastIndexedAtMs)}
                  </span>
                ) : (
                  "—"
                )}
              </div>
              <div>
                <span className="text-muted">DB path: </span>
                <code className="text-xs">{data.dbPath}</code>
              </div>
              <div>
                <span className="text-muted">msg.rowid watermark: </span>
                <code className="text-xs">{data.watermarkMsgRowId ?? 0}</code>
              </div>
              <div>
                <span className="text-muted">Reindex kick: </span>
                {cov.reindexing ? (
                  <Badge tone="accent">queued</Badge>
                ) : (
                  <Badge tone="neutral">idle</Badge>
                )}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Per-chat coverage"
              subtitle="Rows in the index grouped by chat_guid (top 200, most-indexed first)."
            />
            <CardBody className="p-0">
              {bySession.data?.rows.length ? (
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Chat GUID</Th>
                      <Th>Rows</Th>
                      <Th>Last indexed message</Th>
                    </Tr>
                  </Thead>
                  <tbody>
                    {bySession.data.rows.map((r) => (
                      <Tr key={r.chat_guid}>
                        <Td className="font-mono text-xs truncate max-w-md" title={r.chat_guid}>
                          {r.chat_guid}
                        </Td>
                        <Td>{r.n.toLocaleString()}</Td>
                        <Td className="text-xs text-muted">{relativeTime(r.last_ts)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-muted">No data.</p>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs text-muted">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
      </CardBody>
    </Card>
  );
}
