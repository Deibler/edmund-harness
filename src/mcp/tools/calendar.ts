import { z } from "zod";
import {
  addCalendarFeed,
  calendarFeeds,
  fetchCalendar,
  formatEvents,
  normalizeCalendarUrl,
  parseCalendar,
  removeCalendarFeed,
} from "../../feeds/calendar.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

/**
 * The person's own calendar, by the secret iCal link they share (see
 * src/feeds/calendar.ts). Scoped to this chat.
 */
export function calendarTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "connect_calendar",
      description:
        "Connect this person's own calendar so you can see what's coming up before you plan anything with dates. They give you its secret iCal address (Google Calendar: Settings, pick the calendar, 'Secret address in iCal format'; iCloud: share the calendar as Public and copy the link). Offer it when you keep planning around their schedule blind. Read-only; they can revoke it from their calendar app any time.",
      inputSchema: z.object({
        url: z.string().describe("The iCal (.ics or webcal://) link they gave you."),
        label: z.string().optional().describe('A short name, e.g. "work" or "family".'),
      }),
      handler: async (args) => {
        const url = normalizeCalendarUrl(args.url);
        try {
          const ics = await fetchCalendar(url);
          const now = Date.now();
          const n = parseCalendar(ics, now, now + 14 * 86_400_000).length;
          addCalendarFeed(ctx.dataDir, ctx.sessionKey, url, args.label?.trim() || "calendar");
          return text(
            `connected (${n} events in the next two weeks). Use calendar_upcoming to read it.`,
          );
        } catch (err) {
          return text(`couldn't read that calendar link: ${(err as Error).message}`, true);
        }
      },
    },
    {
      name: "calendar_upcoming",
      description:
        "What is on this person's connected calendar for the next few days. Check it before planning trips, dinners, workouts or deadlines, and before suggesting a time.",
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe("How many days ahead. Default 7."),
      }),
      handler: async (args) => {
        const feeds = calendarFeeds(ctx.dataDir, ctx.sessionKey);
        if (feeds.length === 0) {
          return text(
            "No calendar connected in this chat. They can share a secret iCal link with connect_calendar.",
          );
        }
        const now = Date.now();
        const to = now + (args.days ?? 7) * 86_400_000;
        const parts: string[] = [];
        for (const f of feeds) {
          try {
            parts.push(
              `${f.label}:\n${formatEvents(parseCalendar(await fetchCalendar(f.url), now, to))}`,
            );
          } catch (err) {
            parts.push(
              `${f.label}: couldn't read it (${(err as Error).message}); the link may have been reset.`,
            );
          }
        }
        return text(parts.join("\n\n"));
      },
    },
    {
      name: "disconnect_calendar",
      description: "Stop reading a connected calendar in this chat (by its label or link).",
      inputSchema: z.object({ label: z.string() }),
      handler: (args) =>
        removeCalendarFeed(ctx.dataDir, ctx.sessionKey, args.label)
          ? text("disconnected")
          : text("no connected calendar by that name", true),
    },
  ];
}
