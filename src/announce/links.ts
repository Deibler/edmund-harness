/**
 * Where an announcement's link may point.
 *
 * The portal is a single page whose tabs are hash anchors, not routes. That
 * matters more than it sounds: asking for `/u/<key>/<token>/skills` returns
 * HTTP 200 — the dashboard's SPA shell answers it — so a wrong link does not
 * fail, it silently serves the wrong page. A 200 is not evidence a link
 * works, and this is the exact shape that trap takes here.
 *
 * So a link is a tab id, rendered as a fragment, and validated against the
 * real tab list before an announcement can be written. A dead link in an
 * announcement is worse than no link: it goes to people who already trust
 * the sender, and it cannot be recalled.
 */

/**
 * Tab ids on the portal page.
 *
 * MUST match TAB_DEFS in dashboard/server/views/portalPage.ts. They are
 * separate lists because the daemon must not import the dashboard's view
 * layer, so a test pins them together rather than a comment asking nicely.
 */
export const PORTAL_TABS = [
  "home",
  "proactive",
  "credits",
  "skills",
  "whatsnew",
  "media",
  "files",
  "artifacts",
  "schedules",
  "analytics",
  "memory",
  "tips",
  "privacy",
] as const;

export type PortalTab = (typeof PORTAL_TABS)[number];

export type LinkResult = { ok: true; linkPath: string } | { ok: false; reason: string };

/**
 * Normalise an operator-supplied link into a fragment.
 *
 * Accepts "skills", "#skills" or "/skills" — the last because it is the
 * obvious thing to type and silently resolves to the wrong page if passed
 * through. Empty means the portal's front page, which is always valid.
 */
export function normalizeLink(raw: string | null | undefined): LinkResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, linkPath: "" };

  const tab = trimmed.replace(/^[#/]+/, "").toLowerCase();
  if (!PORTAL_TABS.includes(tab as PortalTab)) {
    return {
      ok: false,
      reason: `"${trimmed}" is not a portal tab. Pick one of: ${PORTAL_TABS.join(", ")}`,
    };
  }
  return { ok: true, linkPath: `#${tab}` };
}
