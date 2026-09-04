/**
 * The page's data comes straight from the server's types, so the portal can
 * never drift from what routes/portal.ts actually sends.
 */
import type {
  PortalActivity,
  PortalActivityRow,
  PortalCredits,
  PortalMediaItem,
  PortalNews,
  PortalPageData,
  PortalSkill,
  SkillGroup,
} from "@api/views/portalPage";

export type {
  PortalActivity,
  PortalActivityRow,
  PortalCredits,
  PortalMediaItem,
  PortalNews,
  PortalPageData,
  PortalSkill,
  SkillGroup,
};
export type PortalFile = PortalPageData["files"][number];
export type PortalAnalytics = PortalPageData["analytics"];
export type Job = PortalPageData["jobs"][number];
export type ActiveHoursWindow = PortalPageData["hours"][number];
export type Dow = ActiveHoursWindow["dow"];
