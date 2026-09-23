/**
 * Who may control what.
 *
 * Claude Code's own computer-use server asks a person to approve each app in
 * a dialog. Nobody is at the screen when Edmund works, so the operator
 * approves apps ahead of time in [computer_use]: `apps` for his own sessions,
 * `contact_apps` for everyone else's, and request_access grants exactly those. Everything else follows the same rules: the
 * frontmost app must be granted, browsers are read-only, terminals and IDEs
 * are click-only, and system-wide key combos need their own grant.
 */

import type { InstalledApp } from "./native.ts";

export type Tier = "read" | "click" | "full";

export type Policy = {
  /**
   * The owner, or anyone else Edmund talks to. Contacts get their own app
   * list, see only granted apps in screenshots, and never get the clipboard
   * or system combos.
   */
  tier: "operator" | "contact";
  /** Apps this tier may be granted, by display name or bundle id. */
  apps: string[];
  clipboard: boolean;
  systemKeyCombos: boolean;
};

export type Grant = { bundleId: string; displayName: string; grantedAt: number; tier: Tier };

export type GrantFlags = {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  systemKeyCombos: boolean;
};

const BROWSERS = [
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "org.chromium.Chromium",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "company.thebrowser.Browser",
  "com.brave.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
];

const TERMINALS_AND_IDES = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "com.microsoft.VSCode",
  "com.todesktop.230313mzl4w4u92",
  "com.apple.dt.Xcode",
  "dev.zed.Zed",
  "com.sublimetext.4",
];

/**
 * Browsers can be looked at, not driven: a web page is untrusted content and
 * a click there can reach anything the browser is signed in to. Terminals
 * and IDEs can be clicked and scrolled but not typed into, because typing
 * there is running code.
 */
export function tierOf(bundleId: string): Tier {
  if (BROWSERS.includes(bundleId)) return "read";
  if (TERMINALS_AND_IDES.includes(bundleId) || bundleId.startsWith("com.jetbrains."))
    return "click";
  return "full";
}

/** What an action needs from the tier of the app it lands on. */
export type ActionKind = "click" | "modified-click" | "scroll" | "type" | "pointer";

export function tierAllows(tier: Tier, kind: ActionKind): boolean {
  if (tier === "full") return true;
  if (tier === "click") return kind === "click" || kind === "scroll";
  return false;
}

export const TIER_NOTE: Record<Tier, string> = {
  full: "full control",
  click:
    "visible and left-clickable; typing, keys, right-click, modifier-clicks and drags are blocked",
  read: "visible in screenshots only; clicks and typing are blocked",
};

const norm = (s: string) => s.trim().toLowerCase();

/** Match an app by bundle id, file name or display name, ignoring case. */
export function matchesApp(app: InstalledApp, query: string): boolean {
  const q = norm(query).replace(/\.app$/, "");
  return [app.bundleId, app.name, app.displayName].some((n) => norm(n) === q);
}

export function resolveApp(installed: InstalledApp[], query: string): InstalledApp | null {
  return installed.find((a) => matchesApp(a, query)) ?? null;
}

export function approved(apps: string[], app: InstalledApp): boolean {
  return apps.some((entry) => matchesApp(app, entry));
}
