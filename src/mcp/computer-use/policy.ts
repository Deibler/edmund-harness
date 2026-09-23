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

import type { Config } from "../../config/config.ts";
import { isGuestTier, isOperatorHandle, parseSessionTier } from "../../security/policy.ts";
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

/** iMessage and SMS conversations: the only sessions that act on the screen. */
const CHAT_SESSION = /^(?:imessage|sms):(dm|group):(.+)$/;

/**
 * The [computer_use] policy for this session, or null when it gets no tools.
 *
 * The owner is judged by handle: the session is a DM with one of the
 * operator's own handles ([security] operator_handles, else
 * [alerts] operator_handle). The session tier cannot answer this, because
 * `[security] contact_tier = "operator"` gives every allowlisted contact and
 * group the operator's host access, and the screen is not host access.
 *
 * Everyone else in a DM or a group gets the contact policy, and only while
 * the safety check enforces. Nothing gets tools when the section is
 * disabled, there is no key for the check, the session is a guest's, or it
 * is not a conversation at all (the mirror, a sub-agent, a cron job with no
 * chat).
 */
export function sessionPolicy(
  config: Config | null,
  tierEnv: string | undefined,
  sessionKey: string,
): Policy | null {
  const section = config?.computer_use;
  if (!config || !section?.enabled || !config.keys.openrouter) return null;
  if (isGuestTier(parseSessionTier(tierEnv))) return null;
  const chat = CHAT_SESSION.exec(sessionKey);
  if (!chat) return null;
  if (chat[1] === "dm" && isOperatorHandle(config, chat[2])) {
    return {
      tier: "operator",
      apps: section.apps,
      clipboard: section.clipboard,
      systemKeyCombos: section.system_key_combos,
    };
  }
  if (section.classifier !== "enforce") return null;
  return { tier: "contact", apps: section.contact_apps, clipboard: false, systemKeyCombos: false };
}
