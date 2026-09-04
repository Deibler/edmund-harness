import { Badge } from "@/components/ui/Badge";
import type { CronJobDto } from "@api/types";

const toneByKind: Record<CronJobDto["kind"], "neutral" | "accent" | "warn" | "ok" | "danger"> = {
  scheduled: "accent",
  poke: "neutral",
  retry: "warn",
  "agent-done": "ok",
  "team-done": "ok",
};

export function KindBadge({ kind }: { kind: CronJobDto["kind"] }) {
  return <Badge tone={toneByKind[kind]}>{kind}</Badge>;
}
