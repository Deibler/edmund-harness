/**
 * Whose conversation and whose lists a session may act on.
 *
 * Screen control is shared by everyone who texts Edmund, but a request is
 * always scoped to where it came from: Sam asking in her DM for a heart
 * means a heart in Sam's DM, and a household's grocery request means that
 * household's list. Other conversations and other households' lists are
 * someone else's, whoever asks.
 *
 * Everything here is derived from keyed sources: the session key, chat.db,
 * the contact book, and the kitchen's household registry (through its
 * `screenScope` export). What the screen shows is read from the accessibility
 * tree (see `inspect` in the helper), never from pixels.
 */

import type { Config } from "../../config/config.ts";
import { ChatDb } from "../../imessage/db.ts";
import { getChatDisplayName, getGroupParticipants } from "../../imessage/participants.ts";
import type { ScreenScopeFn } from "../../integrations/contracts.ts";
import { integrationExport } from "../../integrations/optional.ts";
import { AddressBook } from "../../sessions/address-book.ts";
import { ContactBook } from "../../sessions/contacts.ts";
import type { InspectedWindow, Inspection, Rect } from "./native.ts";

export const MESSAGES = "com.apple.MobileSMS";
export const NOTES = "com.apple.Notes";

/** Accessibility identifiers these apps set (macOS 26). */
export const IDS = {
  conversationList: "ConversationList",
  noteBody: "Note Body Text View",
  noteBodyScroll: "Note Body Scroll View",
  noteList: "ICMNoteListTableView_asList",
} as const;

export type Conversation =
  | { kind: "dm"; name: string; handle: string }
  | { kind: "group"; name: string | null; members: string[] };

export type Scope = {
  /** Who is asking, in words. */
  requester: string;
  /** The conversation this session is, or null for one with no chat (a cron turn). */
  conversation: Conversation | null;
  /** Shared notes this session's household owns: its grocery list. */
  ownNotes: string[];
  /** Every other household's list. Never edited from this session. */
  otherNotes: string[];
};

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** 'the DM with Sam', 'the group chat "Sam & Alex Rivera"'. */
export function describeConversation(c: Conversation | null): string {
  if (!c) return "no conversation (this request did not come from a chat)";
  if (c.kind === "dm") return `the DM between Edmund and ${c.name}`;
  const who = c.members.join(", ");
  return c.name ? `the group chat "${c.name}" (members: ${who})` : `the group chat with ${who}`;
}

/**
 * Whether a Messages title is this conversation. A DM is titled with the
 * contact's name, or the number when there is no card; an unnamed group with
 * its members' first names, "Alex, Sam & Morgan".
 */
export function isConversation(c: Conversation | null, title: string): boolean {
  if (!c) return false;
  const t = norm(title);
  if (!t) return false;
  if (c.kind === "dm") {
    if (norm(c.name) === t) return true;
    const d = digits(c.handle);
    return d.length >= 7 && digits(title) === d;
  }
  if (c.name && norm(c.name) === t) return true;
  const tokens = t.split(/\s*,\s*|\s+&\s+/).filter(Boolean);
  const firsts = new Set(c.members.map((m) => norm(m).split(" ")[0]!));
  return tokens.length === firsts.size && tokens.every((x) => firsts.has(x));
}

/**
 * Whether a sidebar row is this conversation's. A row reads "title, preview",
 * and a group's title has commas of its own, so every comma is tried as the
 * end of the title.
 */
export function isConversationRow(c: Conversation | null, row: string): boolean {
  const parts = row.split(",");
  for (let i = 1; i <= parts.length; i++) {
    if (isConversation(c, parts.slice(0, i).join(","))) return true;
  }
  return false;
}

const sameNote = (a: string, b: string) => norm(a) === norm(b);

/** The open note's title in a window: the first line of its body. */
export function openNoteTitle(window: InspectedWindow | undefined): string {
  return (window?.found[IDS.noteBody]?.value ?? "").split("\n")[0]!.trim();
}

/** The window an action lands in: the one under the point, else the front one. */
export function windowAt(
  inspection: Inspection,
  at: { x: number; y: number } | null,
): InspectedWindow | undefined {
  return (at && inspection.windows.find((w) => within(w.frame, at))) || inspection.windows[0];
}

/**
 * The window a key press lands in. A key has no point, and the front window
 * is not always the one being typed in: with several checklist lines selected,
 * Notes puts a small untitled window in front of the note. So: the window
 * holding the focused element, else the frontmost one that has `holds` in it
 * (the note body, the conversation list), else the front one.
 */
export function keyWindow(
  inspection: Inspection,
  focus: { window?: string } | null,
  holds: string,
): InspectedWindow | undefined {
  const has = (w: InspectedWindow) => !!w.frame && !!w.found[holds];
  return (
    (focus?.window
      ? inspection.windows.find((w) => w.title === focus.window && has(w))
      : undefined) ??
    inspection.windows.find(has) ??
    inspection.windows[0]
  );
}

/**
 * Why a note may not be changed from this session, or null when it may. No
 * one edits another household's list; a contact edits only their own.
 */
export function noteRefusal(
  scope: Scope,
  tier: "operator" | "contact",
  title: string,
): string | null {
  const shown = title || "an untitled note";
  if (scope.otherNotes.some((n) => sameNote(n, title))) {
    return `"${shown}" is another household's list. ${ownListsLine(scope)}`;
  }
  if (tier === "contact" && !scope.ownNotes.some((n) => sameNote(n, title))) {
    return `"${shown}" is not this household's list. ${ownListsLine(scope)}`;
  }
  return null;
}

function ownListsLine(scope: Scope): string {
  return scope.ownNotes.length
    ? `This conversation may only edit ${scope.ownNotes.map((n) => `"${n}"`).join(" or ")}.`
    : "This conversation has no household list to edit.";
}

export function isOwnNote(scope: Scope, title: string): boolean {
  return scope.ownNotes.some((n) => sameNote(n, title));
}

/** The row of an inspected list under a point, if any. */
export function rowAt(
  window: InspectedWindow | undefined,
  id: string,
  at: { x: number; y: number } | null,
): { text: string; frame: Rect } | null {
  if (!at) return null;
  return window?.found[id]?.rows.find((r) => within(r.frame, at)) ?? null;
}

export function within(r: Rect | undefined, at: { x: number; y: number }): boolean {
  return !!r && at.x >= r.x && at.x < r.x + r.width && at.y >= r.y && at.y < r.y + r.height;
}

/**
 * What a contact's screenshot must not show of Messages or Notes: every
 * sidebar row that is not theirs, and the open conversation or note when it
 * is not theirs. A window whose structure is not recognised is blacked out
 * whole. Null when the app's windows cannot be read at all (the accessibility
 * tree goes blank while the Mac is locked): nothing can be redacted, so the
 * app must be left out of the capture instead.
 */
export function redactions(scope: Scope, app: string, inspection: Inspection): Rect[] | null {
  if (!inspection.running) return [];
  const windows = inspection.windows.filter((w) => w.frame);
  if (windows.length === 0) return null;
  return windows.flatMap((w) => windowRedactions(scope, app, w));
}

function windowRedactions(scope: Scope, app: string, w: InspectedWindow): Rect[] {
  const frame = w.frame!;
  if (app === MESSAGES) {
    const list = w.found[IDS.conversationList];
    if (!list?.frame) return [frame];
    const out = list.rows
      .filter((r) => !isConversationRow(scope.conversation, r.text))
      .map((r) => r.frame);
    if (!isConversation(scope.conversation, w.title)) {
      const left = list.frame.x + list.frame.width;
      out.push({ x: left, y: frame.y, width: frame.x + frame.width - left, height: frame.height });
    }
    return out;
  }
  if (app === NOTES) {
    const list = w.found[IDS.noteList];
    const body = w.found[IDS.noteBodyScroll];
    // A note opened in its own window has a body and no list.
    if (!list?.frame && !body?.frame) return [frame];
    const out = (list?.rows ?? []).filter((r) => !isOwnNote(scope, r.text)).map((r) => r.frame);
    if (body?.frame && !isOwnNote(scope, openNoteTitle(w))) out.push(body.frame);
    return out;
  }
  return [];
}

/** The scope of one session, from its key. */
export async function loadScope(
  config: Config,
  sessionKey: string,
  tier: "operator" | "contact",
): Promise<Scope> {
  const contacts = new ContactBook(config.contacts, new AddressBook());
  let conversation: Conversation | null = null;
  const dm = /^(?:imessage|sms):dm:(.+)$/.exec(sessionKey);
  const group = /^imessage:group:(.+)$/.exec(sessionKey);
  if (dm) {
    const handle = dm[1]!;
    conversation = { kind: "dm", handle, name: contacts.displayName(handle) ?? handle };
  } else if (group) {
    const db = new ChatDb(config.paths.chat_db);
    try {
      const guid = group[1]!;
      conversation = {
        kind: "group",
        name: getChatDisplayName(db, guid),
        members: getGroupParticipants(db, guid).map((h) => contacts.displayName(h) ?? h),
      };
    } finally {
      db.close();
    }
  }

  const requester =
    conversation?.kind === "dm"
      ? `${conversation.name}${tier === "operator" ? ", the owner of this Mac" : ", a contact who texts Edmund (not the owner of this Mac)"}`
      : conversation
        ? `a member of ${describeConversation(conversation)} (each request line starts with who said it)`
        : tier === "operator"
          ? "the owner of this Mac"
          : "a contact who texts Edmund (not the owner of this Mac)";

  const notesFor = await integrationExport<ScreenScopeFn>(
    "kitchen",
    "screen-scope.ts",
    "screenScope",
  );
  const notes = notesFor ? await notesFor(sessionKey, config) : { own: [], others: [] };
  return { requester, conversation, ownNotes: notes.own, otherNotes: notes.others };
}
