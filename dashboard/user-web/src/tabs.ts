/**
 * The portal's tabs. Ids are hash fragments (`#credits`) and MUST match
 * PORTAL_TABS in src/announce/links.ts — that is the list Edmund's
 * announcements may deep-link to. A test pins the two together.
 */
export type TabId =
  | "home"
  | "proactive"
  | "credits"
  | "media"
  | "files"
  | "artifacts"
  | "skills"
  | "whatsnew"
  | "schedules"
  | "analytics"
  | "memory"
  | "tips"
  | "privacy";

export type TabDef = {
  id: TabId;
  name: string;
  /** One line, in the voice of the page: what the reader finds there. */
  desc: string;
  /** Only in one-to-one conversations. */
  dmOnly?: boolean;
};

export const TABS: TabDef[] = [
  { id: "home", name: "Home", desc: "Where everything is." },
  {
    id: "proactive",
    name: "Proactive",
    desc: "Whether Edmund may text first, when, and a standing note he always reads.",
  },
  {
    id: "credits",
    name: "Credits",
    desc: "Your prepaid balance for images, video and audio, and how to add to it.",
    dmOnly: true,
  },
  { id: "media", name: "Media", desc: "Every image, video and voice memo from this chat." },
  { id: "files", name: "Files", desc: "Edmund's working files for this conversation." },
  { id: "artifacts", name: "Artifacts", desc: "Finished documents and write-ups." },
  { id: "skills", name: "Skills", desc: "What Edmund knows how to do, and who taught him." },
  { id: "whatsnew", name: "What's new", desc: "Things he has picked up lately." },
  { id: "schedules", name: "Schedules", desc: "Reminders and recurring tasks. Make your own." },
  { id: "analytics", name: "Analytics", desc: "Messages, outreach, and workspace numbers." },
  { id: "memory", name: "Memory", desc: "The notes he keeps about you, in full.", dmOnly: true },
  { id: "tips", name: "Tips", desc: "How to get more out of him." },
  { id: "privacy", name: "Privacy", desc: "What is stored, and how to delete it." },
];

export function visibleTabs(p: { isGroup: boolean; hasCredits: boolean }): TabDef[] {
  return TABS.filter((t) => (!t.dmOnly || !p.isGroup) && (t.id !== "credits" || p.hasCredits));
}

export function tabFromHash(hash: string, allowed: TabDef[]): TabId {
  const id = hash.replace(/^#/, "").trim();
  return allowed.some((t) => t.id === id) ? (id as TabId) : "home";
}
