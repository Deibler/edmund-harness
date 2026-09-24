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
import { log } from "../../util/log.ts";
import { parseChord } from "./keys.ts";
import type { Chord, InspectedWindow, Inspection, Rect } from "./native.ts";

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
  /**
   * Every title another conversation in chat.db can be shown under, as
   * `titleKeys` spells them (see `otherTitles`). A title one of them could
   * have does not identify this conversation. Null when chat.db could not be
   * read, and then no title does.
   */
  otherTitles: ReadonlySet<string> | null;
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

/** A number as Messages shows it when there is no card: "+1 (555) 555-0100". */
const PHONE = /^\+?[\d\s().-]+$/;

/**
 * How Messages titles a conversation. A DM: the contact's name, or the
 * number or address when there is no card. A named group: its name. An
 * unnamed group: its members' first names, "Alex, Sam & Morgan", which two
 * different groups can share. Each way is a key, so a title can be looked up
 * against this conversation and against every other one (`titleKeys`).
 */
export function conversationKeys(c: Conversation): string[] {
  if (c.kind === "dm") {
    const d = digits(c.handle);
    return [
      `title:${norm(c.name)}`,
      ...(!c.handle.includes("@") && d.length >= 7 ? [`number:${d}`] : []),
    ];
  }
  if (c.name) return [`title:${norm(c.name)}`];
  return [`members:${c.members.map(memberKey).sort().join("|")}`];
}

/** Every conversation a title shown in Messages could be, as keys. */
export function titleKeys(title: string): string[] {
  const t = norm(title);
  if (!t) return [];
  const keys = [`title:${t}`];
  if (PHONE.test(t) && digits(t).length >= 7) keys.push(`number:${digits(t)}`);
  const members = titleMembers(t);
  if (members) keys.push(`members:${members.sort().join("|")}`);
  return keys;
}

/** A member as an unnamed group's title shows them: first name, else number or address. */
function memberKey(name: string): string {
  const t = norm(name);
  return PHONE.test(t) && digits(t).length >= 7 ? `#${digits(t)}` : t.split(" ")[0]!;
}

/**
 * The members an unnamed group's title lists, or null when the text cannot
 * be one: "Alex", "Alex & Sam", "Alex, Sam & Morgan", each a name, a number
 * or an address. "Alex, Sam" (no "&") is not one, nor "Mac & cheese tonight?".
 */
function titleMembers(t: string): string[] | null {
  const parts = t.split(/\s*,\s*/);
  const last = parts.pop()!.split(/\s+&\s+/);
  if (last.length > 2 || (last.length === 1 && parts.length > 0)) return null;
  const names: string[] = [];
  for (const part of [...parts, ...last]) {
    if (PHONE.test(part)) {
      if (digits(part).length < 7) return null;
      names.push(`#${digits(part)}`);
    } else if (
      part &&
      part !== "unread" &&
      !/[?!:;"“”()&,]/.test(part) &&
      part.split(" ").length <= 3
    ) {
      names.push(part);
    } else {
      return null;
    }
  }
  return names;
}

/** The parts of a scope that say which conversation is this one. */
type ConversationScope = Pick<Scope, "conversation" | "otherTitles">;

/**
 * Whose a Messages title is: this conversation's ("own"), one another
 * conversation could have too ("shared"), or not this one's ("other"). Two
 * unnamed groups with an Alex and a Sam are both "Alex & Sam", so that title
 * identifies neither, and a shared title counts as someone else's.
 */
export function whoseTitle(scope: ConversationScope, title: string): "own" | "shared" | "other" {
  if (!scope.conversation) return "other";
  const keys = titleKeys(title);
  const own = conversationKeys(scope.conversation);
  if (!keys.some((k) => own.includes(k))) return "other";
  const others = scope.otherTitles;
  return !others || keys.some((k) => others.has(k)) ? "shared" : "own";
}

/** Whether a Messages title is this conversation's and no other's. */
export function isConversation(scope: ConversationScope, title: string): boolean {
  return whoseTitle(scope, title) === "own";
}

/**
 * Whether a sidebar row is this conversation's. A row reads "title,
 * preview", and a group's title has commas of its own, so every comma is
 * tried as the end of the title. The row is this conversation's only when
 * that is the one way to read it: a DM with Sam reads "Sam, see you at 6",
 * but so does the group "Sam, Alex & Jordan" with the preview "see you at 6"
 * after it. Any other reading (a title another conversation has, or a list
 * of names that is not this conversation's) makes it someone else's.
 */
export function isConversationRow(scope: ConversationScope, row: string): boolean {
  const { conversation, otherTitles: others } = scope;
  if (!conversation || !others) return false;
  const own = conversationKeys(conversation);
  const parts = row.split(",");
  let mine = false;
  for (let i = 1; i <= parts.length; i++) {
    const title = parts.slice(0, i).join(",");
    const keys = titleKeys(title);
    if (keys.some((k) => others.has(k))) return false;
    if (keys.some((k) => own.includes(k))) mine = true;
    else if ((titleMembers(norm(title))?.length ?? 0) > 1) return false;
  }
  return mine;
}

const keyCode = (name: string) => parseChord(name).keys[0]!;
const SHIFT_MASK = parseChord("shift+a").modifiers[0]![1];
/** Keys that edit a search field's text, move in it, or leave it. */
const SEARCH_EDIT_KEYS = new Set(
  ["delete", "forward_delete", "left", "right", "home", "end", "escape", "space"].map(keyCode),
);
/** The same with shift held: they select text. */
const SEARCH_SELECT_KEYS = new Set(["left", "right", "home", "end"].map(keyCode));
/** Keys that open whichever search result is selected. */
const SEARCH_PICK_KEYS = new Set(["return", "kp_enter", "up", "down"].map(keyCode));
const CHARACTER_KEYS = new Set(
  [..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./"].map(keyCode),
);

/**
 * What an input does in a search field. "edit": typing, deleting and moving
 * in the search text, or leaving the field, so it cannot touch a
 * conversation. "pick": Return, Enter or an arrow up or down, which open the
 * selected result, a conversation nobody can check first. "other": anything
 * else, a menu shortcut such as cmd+delete above all, which acts on
 * whatever conversation is open whatever has focus. Pointer actions aimed at
 * the field itself count as editing it.
 */
export function searchFieldInput(action: string, text?: string): "edit" | "pick" | "other" {
  if (action === "type") {
    if (/[\r\n]/.test(text ?? "")) return "pick";
    return /\t/.test(text ?? "") ? "other" : "edit";
  }
  if (action !== "key" && action !== "hold_key") return "edit";
  let chord: Chord;
  try {
    chord = parseChord(text ?? "");
  } catch {
    return "other";
  }
  if (chord.keys.length !== 1) return "other";
  const key = chord.keys[0]!;
  if (SEARCH_PICK_KEYS.has(key)) return "pick";
  const masks = chord.modifiers.map(([, mask]) => mask);
  if (masks.length === 0 && (SEARCH_EDIT_KEYS.has(key) || CHARACTER_KEYS.has(key))) return "edit";
  const shiftOnly = masks.length === 1 && masks[0] === SHIFT_MASK;
  if (shiftOnly && (CHARACTER_KEYS.has(key) || SEARCH_SELECT_KEYS.has(key))) return "edit";
  return "other";
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
 * The window a key press lands in: the one holding the focused element. A
 * key has no point, and the front window is not always the one being typed
 * in (with several checklist lines selected, Notes puts a small untitled
 * window in front of the note), nor is the one with the sidebar (a
 * conversation opened in its own window has none). So there is no fallback:
 * undefined when focus names no window, names one this app does not have,
 * or names a title several windows share and they differ in `identity` (the
 * conversation or note each shows). The caller refuses then.
 *
 * The helper clips the focused element's window title at 80 characters and
 * marks the cut with "…"; `inspect` reads titles to 200.
 */
export function keyWindow(
  inspection: Inspection,
  focus: { window?: string } | null,
  identity: (w: InspectedWindow) => string,
): InspectedWindow | undefined {
  const title = focus?.window;
  if (!title) return undefined;
  const cut = title.endsWith("…") ? title.slice(0, -1) : null;
  const matches = inspection.windows.filter(
    (w) =>
      !!w.frame &&
      (w.title === title ||
        (cut !== null && w.title.length > cut.length && w.title.startsWith(cut))),
  );
  const first = matches[0];
  return first && matches.every((w) => identity(w) === identity(first)) ? first : undefined;
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
    const out = list.rows.filter((r) => !isConversationRow(scope, r.text)).map((r) => r.frame);
    if (!isConversation(scope, w.title)) {
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
    if (isOwnNote(scope, openNoteTitle(w))) return out;
    // Someone else's note is open, or it cannot be told whose. Without the
    // body's frame (a layout change, or the search stopped short of it) there
    // is nothing smaller to cover it with.
    return body?.frame ? [...out, body.frame] : [frame];
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
  const others = conversation
    ? readOtherTitles(config.paths.chat_db, conversation, group?.[1] ?? null, contacts)
    : null;

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
  return {
    requester,
    conversation,
    otherTitles: others,
    ownNotes: notes.own,
    otherNotes: notes.others,
  };
}

/**
 * `otherTitles` from the chat.db at `path`, or null when it cannot be read:
 * then no title identifies any conversation, and Messages stays closed.
 */
export function readOtherTitles(
  path: string,
  mine: Conversation,
  mineGuid: string | null,
  contacts: ContactBook,
): Set<string> | null {
  try {
    const db = new ChatDb(path);
    try {
      return otherTitles(db, mine, mineGuid, {
        name: (h) => contacts.displayName(h),
        same: (a, b) => contacts.canon(a) === contacts.canon(b),
      });
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn("computer", "could not read the other conversations; Messages stays closed", {
      err: (err as Error).message,
    });
    return null;
  }
}

const CHATS_SQL = `
  SELECT c.guid AS guid, c.style AS style, c.display_name AS name,
         c.chat_identifier AS ident, GROUP_CONCAT(h.id, char(10)) AS handles
  FROM chat c
  LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
  LEFT JOIN handle h             ON h.ROWID = chj.handle_id
  GROUP BY c.ROWID
`;

/**
 * Every title a conversation in chat.db other than `mine` can be shown under
 * (see `conversationKeys`), so a title this conversation shares with one of
 * them identifies neither. `mine`'s own rows are left out: the group's other
 * rows for the same chat, and every DM with the same person. A DM with
 * someone Messages names the same counts as the same person, since a phone
 * and an address on one card look exactly like that; two different people
 * with one name cannot be told apart by a title at all.
 */
export function otherTitles(
  db: ChatDb,
  mine: Conversation,
  mineGuid: string | null,
  people: { name(handle: string): string | null; same(a: string, b: string): boolean },
): Set<string> {
  const rows = db
    .query<{
      guid: string;
      style: number | null;
      name: string | null;
      ident: string | null;
      handles: string | null;
    }>(CHATS_SQL)
    .all();
  const mineIdent = mineGuid ? rows.find((r) => r.guid === mineGuid)?.ident : undefined;
  const keys = new Set<string>();
  for (const r of rows) {
    const handles = (r.handles ?? "").split("\n").filter(Boolean);
    let c: Conversation;
    if (r.style === 43) {
      if (mine.kind === "group" && (r.guid === mineGuid || (!!mineIdent && r.ident === mineIdent)))
        continue;
      c = {
        kind: "group",
        name: r.name?.trim() || null,
        members: handles.map((h) => people.name(h) ?? h),
      };
    } else {
      const handle = handles[0] ?? r.ident ?? "";
      if (!handle) continue;
      const name = people.name(handle) ?? handle;
      if (
        mine.kind === "dm" &&
        (people.same(handle, mine.handle) || norm(name) === norm(mine.name))
      )
        continue;
      c = { kind: "dm", handle, name };
    }
    for (const k of conversationKeys(c)) keys.add(k);
  }
  return keys;
}
