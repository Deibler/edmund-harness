import { PageTitle } from "@/components/PageTitle";
import { Paper, Row, Tag } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { describeJob } from "@/lib/format";
import type { PortalPageData } from "@/types";
import { useState } from "react";
import { toast } from "sonner";

type Freq = "once" | "hourly" | "daily" | "weekly";

export function Schedules({ data, reload }: { data: PortalPageData; reload: () => Promise<void> }) {
  const you = data.isGroup ? "the group" : "you";
  const [prompt, setPrompt] = useState("");
  const [freq, setFreq] = useState<Freq>("daily");
  const [time, setTime] = useState("09:00");
  const [dow, setDow] = useState("mon");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, action: "pause" | "resume" | "cancel") => {
    setBusy(id);
    const r = await post(`/cron/${encodeURIComponent(id)}/${action}`);
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    toast.success(action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Deleted");
    await reload();
  };

  const create = async () => {
    const p = prompt.trim();
    if (!p) return toast.error("Describe what Edmund should do");
    const body: Record<string, unknown> = { prompt: p, freq, time: time || "09:00", dow };
    if (freq === "once") {
      if (!at) return toast.error("Pick a date and time");
      const atMs = new Date(at).getTime();
      if (!(atMs > Date.now())) return toast.error("Pick a time in the future");
      body.atMs = atMs;
    }
    setBusy("create");
    const r = await post("/cron/create", body);
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    toast.success("Scheduled");
    setPrompt("");
    await reload();
  };

  const field =
    "h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

  return (
    <div>
      <PageTitle
        title="Schedules"
        lede={`Reminders and recurring tasks for this chat. Pause stops one without deleting it. You can also just text Edmund "remind me…" and he sets it up himself.`}
      />

      <Paper title="Scheduled" padded={false}>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          {data.jobs.length === 0 ? (
            <p className="py-2 text-[14px] text-muted-foreground">Nothing scheduled right now.</p>
          ) : (
            data.jobs.map((j) => {
              const d = describeJob(j, data.tz);
              const paused = j.status === "paused";
              return (
                <Row
                  key={j.id}
                  className="items-start"
                  right={
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === j.id}
                        onClick={() => act(j.id, paused ? "resume" : "pause")}
                      >
                        {paused ? "Resume" : "Pause"}
                      </Button>
                      {d.mine ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy === j.id}
                          onClick={() => act(j.id, "cancel")}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="line-clamp-3 text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">
                      {d.title}
                    </span>
                    {paused ? <Tag tone="warn">paused</Tag> : null}
                    {d.mine ? <Tag>yours</Tag> : null}
                  </div>
                  <div className="mt-0.5 text-[13px] text-muted-foreground">{d.when}</div>
                </Row>
              );
            })
          )}
        </div>
      </Paper>

      <Paper
        title="Create a schedule"
        description={`Tell Edmund what to do and when. When it fires, he does the work and texts ${you} the result.`}
      >
        <Textarea
          value={prompt}
          maxLength={400}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Send me the weather forecast and anything interesting happening in Lancaster today"
          className="min-h-24 bg-card text-[15px] leading-relaxed"
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[13px] text-muted-foreground">Repeats</span>
            <select
              value={freq}
              onChange={(e) => setFreq(e.target.value as Freq)}
              className={field}
            >
              <option value="once">Once</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          {freq === "once" ? (
            <label className="block">
              <span className="mb-1 block text-[13px] text-muted-foreground">When</span>
              <input
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                className={`${field} tnum`}
              />
            </label>
          ) : null}
          {freq === "weekly" ? (
            <label className="block">
              <span className="mb-1 block text-[13px] text-muted-foreground">Day</span>
              <select value={dow} onChange={(e) => setDow(e.target.value)} className={field}>
                {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d) => (
                  <option key={d} value={d}>
                    {
                      {
                        mon: "Monday",
                        tue: "Tuesday",
                        wed: "Wednesday",
                        thu: "Thursday",
                        fri: "Friday",
                        sat: "Saturday",
                        sun: "Sunday",
                      }[d]
                    }
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {freq === "daily" || freq === "weekly" ? (
            <label className="block">
              <span className="mb-1 block text-[13px] text-muted-foreground">At ({data.tz})</span>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={`${field} tnum`}
              />
            </label>
          ) : null}
        </div>
        <Button
          onClick={create}
          disabled={busy === "create"}
          className="mt-4 h-11 w-full text-[15px] sm:h-10 sm:w-auto sm:px-5"
        >
          {busy === "create" ? "Creating…" : "Create schedule"}
        </Button>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Up to 10 schedules of your own per chat. Hourly ones fire on the hour.
        </p>
      </Paper>
    </div>
  );
}
