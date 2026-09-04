import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { AgentTable } from "@/features/agents/AgentTable";
import { useAgents } from "@/features/agents/useAgents";
import { CronTable } from "@/features/cron/CronTable";
import { useCronJobs } from "@/features/cron/useCronJobs";
import { MediaGrid } from "@/features/media/MediaGrid";
import { useMedia } from "@/features/media/useMedia";
import { ChatPane } from "@/features/messages/ChatPane";
import { useResetSession, useSession } from "@/features/sessions/useSessions";
import { fmtTime } from "@/lib/time";
import { useState } from "react";
import { useParams } from "react-router-dom";

export function SessionDetailPage() {
  const { key: encodedKey } = useParams<{ key: string }>();
  const sessionKey = encodedKey ? decodeURIComponent(encodedKey) : "";
  const { data } = useSession(sessionKey || undefined);
  const [tab, setTab] = useState("messages");
  const toast = useToast();
  const reset = useResetSession();
  const agents = useAgents({ sessionKey });
  const crons = useCronJobs(sessionKey);
  const media = useMedia(sessionKey);

  if (!sessionKey) return null;
  const s = data?.session;

  return (
    <div>
      <PageHeader
        title={s?.label ?? "Session"}
        description={sessionKey}
        actions={
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              try {
                await reset.mutateAsync(sessionKey);
                toast.push({ tone: "ok", title: "Session memory cleared" });
              } catch (e) {
                toast.push({ tone: "danger", title: "Failed", description: (e as Error).message });
              }
            }}
          >
            Reset Claude session
          </Button>
        }
      />
      {s ? (
        <div className="flex gap-2 mb-4 text-xs text-muted">
          <Badge tone={s.isGroup ? "accent" : "neutral"}>{s.isGroup ? "group" : "dm"}</Badge>
          <span>Last in: {fmtTime(s.lastInboundMs)}</span>
          <span>Last out: {fmtTime(s.lastOutboundMs)}</span>
          <span>Chat GUID: {s.chatGuid ?? "—"}</span>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="cron">Cron ({crons.data?.jobs.length ?? 0})</TabsTrigger>
          <TabsTrigger value="agents">Agents ({agents.data?.agents.length ?? 0})</TabsTrigger>
          <TabsTrigger value="media">Media ({media.data?.items.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="messages">
          <ChatPane sessionKey={sessionKey} />
        </TabsContent>
        <TabsContent value="cron">
          <CronTable jobs={crons.data?.jobs ?? []} showSession={false} />
        </TabsContent>
        <TabsContent value="agents">
          <AgentTable agents={agents.data?.agents ?? []} showSession={false} />
        </TabsContent>
        <TabsContent value="media">
          <MediaGrid items={media.data?.items ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
