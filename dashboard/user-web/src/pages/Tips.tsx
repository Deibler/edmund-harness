import { PageTitle } from "@/components/PageTitle";
import type { PortalPageData } from "@/types";

export function Tips({ data }: { data: PortalPageData }) {
  const tips: Array<[string, string]> = [
    [
      "Be specific about the result you want",
      "“Make me a one-page checklist PDF for closing the pool” beats “help with the pool”. Edmund can do real multi-step work. Give him the finish line.",
    ],
    [
      "Send photos, screenshots and voice memos",
      "He reads documents, identifies things in pictures, listens to voice notes and works from screenshots. Often faster than typing it out.",
    ],
    [
      "Put him on a schedule",
      "Text “every weekday at 7am send me the forecast and my reminders”, or build it on the Schedules page. He does the work fresh each time.",
    ],
    [
      "Ask for real artifacts",
      "Webpages, spreadsheets, PDFs, edited images, QR codes, research write-ups. Anything he makes shows up under Media, Files and Artifacts.",
    ],
    data.isGroup
      ? [
          "Address him by name in the group",
          "In group chats, mention Edmund when you want him. He stays out of conversations that are not for him.",
        ]
      : [
          "Teach him once and he remembers",
          "Corrections and preferences stick. “My daughter's name is June.” “Never use emojis with me.” The Memory page shows what he has kept.",
        ],
    [
      "Long jobs are fine",
      "“Research this and get back to me” works. He goes off, does the work, and texts you when it is done. You do not need to keep the conversation open.",
    ],
    [
      "Steer the proactive messages",
      "The note on the Proactive page is read every time he considers reaching out. Say exactly what is welcome and what is not.",
    ],
    [
      "Lost this page?",
      "Text Edmund “send me my portal link” and he sends a fresh one. The link is private to this chat, so do not forward it.",
    ],
  ];
  return (
    <div>
      <PageTitle title="Tips" lede="How to get more out of Edmund." />
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {tips.map(([title, body]) => (
          <div key={title} className="border-b border-border/70 px-4 py-4 last:border-b-0 sm:px-5">
            <h3 className="text-[1.05rem]">{title}</h3>
            <p className="mt-1 text-[14.5px] leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[13.5px] leading-relaxed text-muted-foreground">
        Everything here is scoped to this one conversation. The address is your key: anyone holding
        the exact link can see and change this chat's settings, so treat it like a password.
      </p>
    </div>
  );
}
