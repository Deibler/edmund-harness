import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useId, useState } from "react";
import { useCreateCron } from "./useCronJobs";

type Mode = "once" | "cron";

export function CreateCronDialog({
  open,
  onOpenChange,
  sessionKey,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sessionKey?: string;
}) {
  const toast = useToast();
  const create = useCreateCron();
  const keyId = useId();
  const eventId = useId();
  const whenId = useId();
  const exprId = useId();
  const [targetKey, setTargetKey] = useState(sessionKey ?? "");
  const [event, setEvent] = useState("Reminder: check in");
  const [mode, setMode] = useState<Mode>("once");
  const [atLocal, setAtLocal] = useState(() => {
    const d = new Date(Date.now() + 60_000);
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [expr, setExpr] = useState("0 8 * * *");

  async function submit() {
    if (!targetKey || !event) {
      toast.push({ tone: "danger", title: "session and event required" });
      return;
    }
    const schedule =
      mode === "once"
        ? { kind: "once" as const, atMs: new Date(atLocal).getTime() }
        : { kind: "cron" as const, expr };
    try {
      await create.mutateAsync({ sessionKey: targetKey, systemEvent: event, schedule });
      toast.push({ tone: "ok", title: "cron created" });
      onOpenChange(false);
    } catch (e) {
      toast.push({ tone: "danger", title: "failed", description: (e as Error).message });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New cron job"
      description="Schedules a system event that wakes the model for a specific session."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-muted mb-1" htmlFor={keyId}>
            Session key
          </label>
          <Input
            id={keyId}
            placeholder="imessage:dm:…"
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1" htmlFor={eventId}>
            Event text
          </label>
          <Input id={eventId} value={event} onChange={(e) => setEvent(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === "once" ? "primary" : "secondary"}
            onClick={() => setMode("once")}
          >
            Once
          </Button>
          <Button
            size="sm"
            variant={mode === "cron" ? "primary" : "secondary"}
            onClick={() => setMode("cron")}
          >
            Cron
          </Button>
        </div>
        {mode === "once" ? (
          <div>
            <label className="block text-xs text-muted mb-1" htmlFor={whenId}>
              When (local)
            </label>
            <Input
              id={whenId}
              type="datetime-local"
              value={atLocal}
              onChange={(e) => setAtLocal(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="block text-xs text-muted mb-1" htmlFor={exprId}>
              Cron expression
            </label>
            <Input
              id={exprId}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted mt-1">5 fields: min hour dom month dow</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
