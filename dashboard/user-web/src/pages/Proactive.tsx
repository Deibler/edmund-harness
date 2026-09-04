import { PageTitle } from "@/components/PageTitle";
import { Paper } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ActiveHoursWindow, Dow, PortalPageData } from "@/types";
import { useState } from "react";
import { toast } from "sonner";

const DOWS: Dow[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DOW_NAME: Record<Dow, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

type DayState = { on: boolean; start: string; end: string };

export function Proactive({ data }: { data: PortalPageData }) {
  const you = data.isGroup ? "this group" : "you";
  const [enabled, setEnabled] = useState(data.enabled);
  const [note, setNote] = useState(data.note);
  const [days, setDays] = useState<Record<Dow, DayState>>(() => {
    const out = {} as Record<Dow, DayState>;
    for (const d of DOWS) {
      const w = data.hours.find((h) => h.dow === d);
      out[d] = { on: w !== undefined, start: w?.start ?? "09:00", end: w?.end ?? "21:00" };
    }
    return out;
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const activeHours: ActiveHoursWindow[] = DOWS.filter((d) => days[d].on).map((d) => ({
      dow: d,
      start: days[d].start || "09:00",
      end: days[d].end || "21:00",
    }));
    const r = await post("/settings", { enabled, activeHours, note });
    setSaving(false);
    if (r.ok) toast.success("Saved");
    else toast.error(`Could not save: ${r.error}`);
  };

  return (
    <div>
      <PageTitle
        title="Proactive messages"
        lede={`Whether Edmund may text ${you} first, and when. His replies are never limited by any of this.`}
      />

      <Paper>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium">Let Edmund reach out unprompted</div>
            <div className="text-[13.5px] text-muted-foreground">
              Off means he only ever replies when {data.isGroup ? "someone here" : "you"} texts
              first.
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => setEnabled(Boolean(v))}
            aria-label="Allow proactive messages"
          />
        </div>
      </Paper>

      <Paper
        title="Hours he may text"
        description={`Turn a day off to block it entirely. Times are ${data.tz}. This only limits messages he starts.`}
        padded={false}
      >
        <div className="divide-y divide-border/70 px-4 pb-2 sm:px-5">
          {DOWS.map((d) => {
            const s = days[d];
            return (
              <div
                key={d}
                className="grid grid-cols-[1fr_auto] items-center gap-3 py-2.5 sm:grid-cols-[7rem_auto_1fr]"
              >
                <div className="text-[15px]">{DOW_NAME[d]}</div>
                <Switch
                  checked={s.on}
                  onCheckedChange={(v) => setDays({ ...days, [d]: { ...s, on: Boolean(v) } })}
                  aria-label={`${DOW_NAME[d]} on`}
                />
                <div
                  className={cn(
                    "col-span-2 flex items-center gap-2 sm:col-span-1",
                    !s.on && "opacity-40",
                  )}
                >
                  <input
                    type="time"
                    value={s.start}
                    disabled={!s.on}
                    onChange={(e) => setDays({ ...days, [d]: { ...s, start: e.target.value } })}
                    className="tnum h-10 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-[15px]"
                  />
                  <span className="text-muted-foreground">to</span>
                  <input
                    type="time"
                    value={s.end}
                    disabled={!s.on}
                    onChange={(e) => setDays({ ...days, [d]: { ...s, end: e.target.value } })}
                    className="tnum h-10 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-[15px]"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Paper>

      <Paper
        title="A note to Edmund"
        description="Your own words. He reads this every time he considers reaching out."
      >
        <Textarea
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`Only message me about fishing and the weather. Never before noon. More memes.`}
          className="min-h-28 bg-card text-[15px] leading-relaxed"
        />
        <Button
          onClick={save}
          disabled={saving}
          className="mt-4 h-11 w-full text-[15px] sm:h-10 sm:w-auto sm:px-5"
        >
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </Paper>
    </div>
  );
}
