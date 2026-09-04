import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { fmtTimeFull } from "@/lib/time";
import { useState } from "react";
import { useHistory, useSendMessage } from "./useMessages";

export function ChatPane({ sessionKey }: { sessionKey: string }) {
  const { data, isLoading } = useHistory(sessionKey);
  const send = useSendMessage();
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [text, setText] = useState("");

  async function onSend() {
    if (!text.trim()) return;
    try {
      await send.mutateAsync({ sessionKey, text });
      toast.push({ tone: "ok", title: "Message sent" });
      setText("");
      setDialog(false);
    } catch (e) {
      toast.push({ tone: "danger", title: "Send failed", description: (e as Error).message });
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted">
          Last {data?.lines.length ?? 0} messages from chat.db
        </div>
        <Button size="sm" variant="danger" onClick={() => setDialog(true)}>
          Send as assistant
        </Button>
      </div>
      <div className="space-y-2 max-h-[60vh] overflow-auto">
        {isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : data?.lines.length === 0 ? (
          <p className="text-sm text-muted">No messages in this chat.</p>
        ) : (
          data?.lines.map((l) => (
            <div
              key={l.rowId}
              className={
                l.fromMe
                  ? "ml-auto max-w-[75%] rounded-lg bg-accent/20 border border-accent/30 p-2"
                  : "mr-auto max-w-[75%] rounded-lg bg-card border border-border p-2"
              }
            >
              <div className="text-xs text-muted mb-0.5">
                {l.fromLabel} · {fmtTimeFull(l.timestampMs)}
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{l.text}</div>
            </div>
          ))
        )}
      </div>

      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Send as assistant"
        description="This sends a real iMessage directly from your Mac. Goes out as if Claude sent it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={onSend} disabled={send.isPending || !text.trim()}>
              Send
            </Button>
          </>
        }
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message text"
          autoFocus
        />
      </Dialog>
    </div>
  );
}
