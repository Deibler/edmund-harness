/**
 * Actions in words, for the safety check.
 *
 * A click is a pair of numbers until it is said what it lands on. The
 * accessibility tree knows: 'button "Empty" in Finder, window "Trash"' is
 * something a classifier can judge, and (730, 410) is not.
 */

import type { PointOwner } from "./native.ts";

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
