/**
 * Key chords: "cmd+shift+a", "Return", "ctrl+Page_Down".
 *
 * Names are case-insensitive and accept both xdotool spellings (BackSpace,
 * Page_Up, KP_Enter) and the Mac key labels (delete, option, command).
 * Codes are macOS virtual key codes on the ANSI layout.
 */

import type { Chord } from "./native.ts";

type Modifier = "cmd" | "shift" | "alt" | "ctrl" | "fn";

const MODIFIERS: Record<Modifier, [code: number, mask: number]> = {
  cmd: [0x37, 0x100000],
  shift: [0x38, 0x20000],
  alt: [0x3a, 0x80000],
  ctrl: [0x3b, 0x40000],
  fn: [0x3f, 0x800000],
};

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: "cmd",
  command: "cmd",
  super: "cmd",
  meta: "cmd",
  win: "cmd",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  fn: "fn",
};

/**
 * The ANSI key positions: the character at index N is the one virtual key
 * code N types. Gaps (NUL) are keys with no character: the ISO section key,
 * Return, Tab and Space.
 */
const ANSI = "asdfhgzxcv\0bqweryt123465=97-80]ou[ip\0lj'k;\\,/nm.\0\0`";

/** Shifted characters, each above the unshifted one at the same index. */
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
const UNSHIFTED = "`1234567890-=[]\\;',./";

const CHARACTER_NAMES: Record<string, string> = {
  minus: "-",
  equal: "=",
  equals: "=",
  plus: "+",
  underscore: "_",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  quote: "'",
  comma: ",",
  period: ".",
  slash: "/",
  grave: "`",
};

/** Named keys and their aliases. "delete" is the Mac label for backspace. */
const NAMED_KEYS: Array<[code: number, names: string[]]> = [
  [0x24, ["return", "enter"]],
  [0x4c, ["kp_enter"]],
  [0x30, ["tab"]],
  [0x31, ["space"]],
  [0x33, ["backspace", "back_space", "delete"]],
  [0x75, ["forward_delete", "forwarddelete", "del"]],
  [0x35, ["escape", "esc"]],
  [0x7e, ["up", "arrowup"]],
  [0x7d, ["down", "arrowdown"]],
  [0x7b, ["left", "arrowleft"]],
  [0x7c, ["right", "arrowright"]],
  [0x73, ["home"]],
  [0x77, ["end"]],
  [0x74, ["page_up", "pageup", "prior"]],
  [0x79, ["page_down", "pagedown", "next"]],
  [0x39, ["caps_lock", "capslock"]],
  [0x72, ["help", "insert"]],
];

/** F1 through F20. */
const FUNCTION_KEYS = [
  0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a,
  0x40, 0x4f, 0x50, 0x5a,
];

const NAMED = new Map(NAMED_KEYS.flatMap(([code, names]) => names.map((n) => [n, code] as const)));

/** A key's code, and whether typing it needs shift. */
function keyOf(name: string): { code: number; shift: boolean } | undefined {
  const lower = name.toLowerCase();
  const named = NAMED.get(lower);
  if (named !== undefined) return { code: named, shift: false };
  const fn = /^f(\d{1,2})$/.exec(lower);
  if (fn) {
    const code = FUNCTION_KEYS[Number(fn[1]) - 1];
    return code === undefined ? undefined : { code, shift: false };
  }
  const ch = CHARACTER_NAMES[lower] ?? (name.length === 1 ? lower : undefined);
  if (ch === undefined) return undefined;
  const shifted = SHIFTED.indexOf(ch);
  const base = shifted >= 0 ? UNSHIFTED[shifted]! : ch;
  const code = ANSI.indexOf(base);
  return code < 0 || base === "\0" ? undefined : { code, shift: shifted >= 0 };
}

/**
 * Parse a chord. Modifiers may appear in any order; a trailing "+" is the
 * plus key ("cmd++"). Throws with the offending name on anything unknown.
 */
export function parseChord(text: string): Chord {
  const parts = splitChord(text.trim());
  if (parts.length === 0) throw new Error("empty key chord");
  const mods = new Set<Modifier>();
  const keys: number[] = [];
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    const key = keyOf(part);
    if (!key) throw new Error(`unknown key "${part}" in "${text}"`);
    if (key.shift) mods.add("shift");
    keys.push(key.code);
  }
  // A bare modifier ("shift") is a key press of that modifier.
  if (keys.length === 0) {
    const only = [...mods];
    return {
      modifiers: only.slice(0, -1).map((m) => MODIFIERS[m]),
      keys: [MODIFIERS[only.at(-1)!][0]],
    };
  }
  const order: Modifier[] = ["ctrl", "alt", "shift", "cmd", "fn"];
  return { modifiers: order.filter((m) => mods.has(m)).map((m) => MODIFIERS[m]), keys };
}

function splitChord(text: string): string[] {
  if (text === "+") return ["+"];
  const parts = text.split("+");
  // "cmd++" splits to ["cmd", "", ""]: the empty tail is the plus key.
  if (text.endsWith("++")) return [...parts.slice(0, -2), "+"].filter(Boolean);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The flag mask a click or scroll holds for a modifier string like "shift+cmd". */
export function modifierFlags(text: string | undefined): number {
  if (!text?.trim()) return 0;
  const chord = parseChord(text);
  const modifierCodes = new Set(Object.values(MODIFIERS).map(([code]) => code));
  if (chord.keys.some((k) => !modifierCodes.has(k)))
    throw new Error(`"${text}" is not a set of modifier keys`);
  let mask = 0;
  for (const [, m] of chord.modifiers) mask |= m;
  for (const k of chord.keys) mask |= Object.values(MODIFIERS).find(([code]) => code === k)![1];
  return mask;
}

/**
 * Chords that act on the whole system rather than the frontmost app: quit,
 * switch app, hide, lock, log out, force quit, Spotlight and Spaces.
 */
const SYSTEM_COMBOS = [
  "cmd+q",
  "cmd+tab",
  "cmd+shift+tab",
  "cmd+h",
  "cmd+alt+h",
  "cmd+ctrl+q",
  "cmd+shift+q",
  "cmd+alt+shift+q",
  "cmd+alt+escape",
  "cmd+space",
  "ctrl+up",
  "ctrl+down",
  "ctrl+left",
  "ctrl+right",
].map(chordKey);

function chordKey(text: string | Chord): string {
  const chord = typeof text === "string" ? parseChord(text) : text;
  const mods = chord.modifiers.map(([, m]) => m).reduce((a, b) => a | b, 0);
  return `${mods}:${[...chord.keys].sort((a, b) => a - b).join(",")}`;
}

export function isSystemCombo(chord: Chord): boolean {
  return SYSTEM_COMBOS.includes(chordKey(chord));
}

/** What macOS does with common chords, so the classifier is not left to guess. */
const MEANINGS: Array<[chord: string, meaning: (app: string) => string]> = [
  ["cmd+q", (app) => `Quit ${app}`],
  ["cmd+w", () => "Close Window"],
  ["cmd+alt+w", () => "Close All Windows"],
  ["cmd+h", (app) => `Hide ${app}`],
  ["cmd+alt+h", () => "Hide Others"],
  ["cmd+m", () => "Minimize"],
  ["cmd+tab", () => "Switch App"],
  ["cmd+shift+tab", () => "Switch App"],
  ["cmd+space", () => "Spotlight"],
  ["cmd+ctrl+q", () => "Lock Screen"],
  ["cmd+shift+q", () => "Log Out"],
  ["cmd+alt+shift+q", () => "Log Out without confirming"],
  ["cmd+alt+escape", () => "Force Quit Applications"],
  ["cmd+c", () => "Copy"],
  ["cmd+v", () => "Paste"],
  ["cmd+x", () => "Cut"],
  ["cmd+z", () => "Undo"],
  ["cmd+shift+z", () => "Redo"],
  ["cmd+a", () => "Select All"],
  ["cmd+s", () => "Save"],
  ["cmd+n", () => "New"],
  ["cmd+f", () => "Find"],
  ["cmd+p", () => "Print"],
  ["cmd+delete", (app) => (app === "Finder" ? "Move to Trash" : "Delete to start of line")],
  ["cmd+shift+delete", (app) => (app === "Finder" ? "Empty Trash" : "Delete")],
  [
    "cmd+alt+shift+delete",
    (app) => (app === "Finder" ? "Empty Trash without confirming" : "Delete"),
  ],
  ["ctrl+up", () => "Mission Control"],
  ["ctrl+down", () => "App windows"],
  ["ctrl+left", () => "Previous Space"],
  ["ctrl+right", () => "Next Space"],
];

const MEANING_BY_KEY = new Map(MEANINGS.map(([text, meaning]) => [chordKey(text), meaning]));

/** "Quit Notes", "Lock Screen", or null for a chord with no system meaning. */
export function chordMeaning(chord: Chord, app: string): string | null {
  return MEANING_BY_KEY.get(chordKey(chord))?.(app) ?? null;
}

/**
 * Chords refused outright, with no classifier: nothing a person asks of
 * Edmund needs the session ended, and Messages is the process Edmund talks
 * through, so quitting it takes him offline.
 */
export function blockedChord(chord: Chord, frontmostBundleId: string): string | null {
  const key = chordKey(chord);
  if (key === chordKey("cmd+ctrl+q")) return "locks the screen";
  if (key === chordKey("cmd+shift+q") || key === chordKey("cmd+alt+shift+q")) return "logs out";
  if (key === chordKey("cmd+alt+escape")) return "opens Force Quit";
  if (key === chordKey("cmd+q") && frontmostBundleId === "com.apple.MobileSMS") {
    return "quits Messages, which Edmund talks through";
  }
  if (
    frontmostBundleId === "com.apple.finder" &&
    (key === chordKey("cmd+shift+delete") || key === chordKey("cmd+alt+shift+delete"))
  ) {
    return "empties the Trash";
  }
  return null;
}
