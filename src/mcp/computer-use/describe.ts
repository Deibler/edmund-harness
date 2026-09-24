/**
 * Actions in words, for the safety check.
 *
 * A click is a pair of numbers until it is said what it lands on. The
 * accessibility tree knows: 'button "Empty" in Finder, window "Trash"' is
 * something a classifier can judge, and (730, 410) is not.
 */

import type { Chord, PointOwner } from "./native.ts";

const ROLES: Record<string, string> = {
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio button",
  AXPopUpButton: "pop-up button",
  AXMenuButton: "menu button",
  AXMenuItem: "menu item",
  AXMenuBarItem: "menu bar item",
  AXDockItem: "Dock item",
  AXTextField: "text field",
  AXTextArea: "text area",
  AXSecureTextField: "password field",
  AXComboBox: "combo box",
  AXStaticText: "text",
  AXLink: "link",
  AXSlider: "slider",
  AXIncrementor: "stepper",
  AXRow: "row",
  AXCell: "cell",
  AXImage: "image",
  AXWebArea: "web page",
  AXList: "list",
  AXTable: "table",
  AXOutline: "outline",
  AXTabGroup: "tab group",
  AXToolbar: "toolbar",
  AXScrollArea: "scroll area",
  AXGroup: "group",
  AXWindow: "window",
};

const SUBROLES: Record<string, string> = {
  AXSwitch: "switch",
  AXSearchField: "search field",
  AXSecureTextField: "password field",
  AXTabButton: "tab",
};

/** 'switch "Firewall" (value "1") in System Settings, window "Network"' */
export function describeElement(o: PointOwner): string {
  if (o.role === "desktop") return "the desktop";
  const app = o.name || o.bundleId || "an unidentified app";
  if (!o.role && !o.label) return `a window of ${app}`;
  const kind =
    SUBROLES[o.subrole ?? ""] ??
    ROLES[o.role] ??
    (o.role.replace(/^AX/, "").toLowerCase() || "element");
  const label = o.label ? ` "${clip(o.label, 80)}"` : "";
  const value = o.value ? ` (value "${clip(o.value, 60)}")` : "";
  const window = o.window ? `, window "${clip(o.window, 80)}"` : "";
  return `${kind}${label}${value} in ${app}${window}`;
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const BACKSPACE = 0x33;
const FORWARD_DELETE = 0x75;

/**
 * The text pressing Delete (backspace) or forward-delete `repeat` times would
 * remove, read from the focused text: the selection first, then one character
 * beside the caret per further press. Null for any other key, with a modifier
 * (a word or a line at a time, whose reach is not worked out here), or when
 * the focused element does not report its text.
 */
export function deletedText(chord: Chord, focus: PointOwner | null, repeat: number): string | null {
  if (chord.modifiers.length || chord.keys.length !== 1) return null;
  const key = chord.keys[0];
  if (key !== BACKSPACE && key !== FORWARD_DELETE) return null;
  if (!focus?.selection) return null;
  const selected = focus.selectedText ?? "";
  const more = Math.max(0, focus.selection.length > 0 ? repeat - 1 : repeat);
  if (key === FORWARD_DELETE) return selected + (focus.textAfter ?? "").slice(0, more);
  const before = focus.textBefore ?? "";
  return before.slice(Math.max(0, before.length - more)) + selected;
}

/** Delete or forward-delete with no modifier, or Cut: a key that removes what is selected. */
export function removesSelection(chord: Chord, meaning: string | null): boolean {
  if (meaning === "Cut") return true;
  if (chord.modifiers.length || chord.keys.length !== 1) return false;
  return chord.keys[0] === BACKSPACE || chord.keys[0] === FORWARD_DELETE;
}

/** Text quoted in an action: line breaks made visible, and clipped. */
export function quoted(text: string, max = 400): string {
  return `"${clip(text.replace(/\r\n|\r|\n/g, "⏎"), max)}"`;
}
