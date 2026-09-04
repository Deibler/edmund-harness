import { resolve } from "node:path";
import { Hono } from "hono";
import { RateLimiter } from "../../../src/annotate/rate-limit.ts";
import { AnnouncementStore } from "../../../src/announce/store.ts";
import { loadPersona } from "../../../src/claude/persona.ts";
import type { Config } from "../../../src/config/config.ts";
import type { CreditStore } from "../../../src/credits/store.ts";
import type { CronStore } from "../../../src/cron/store.ts";
import type { JobSchedule } from "../../../src/cron/types.ts";
import { resolveIntensity } from "../../../src/ghost/intensity.ts";
import {
  type ActiveHoursWindow,
  DEFAULT_ACTIVE_HOURS_DM,
  type GhostPrefsStore,
} from "../../../src/ghost/prefs.ts";
import { getGroupParticipants } from "../../../src/imessage/participants.ts";
import { sandboxDir } from "../../../src/persona/sandbox.ts";
import { privacyConfirmed } from "../../../src/portal/privacy-confirm.ts";
import { portalUrl, verifyPortalParts } from "../../../src/portal/token.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { SessionKey } from "../../../src/sessions/key.ts";
import { chatIdFromKey, isGroupSession } from "../../../src/sessions/key.ts";
import { chatGuidsForSession } from "../../../src/sessions/session-scope.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { sessionLabel } from "../services/labels.ts";
import { listMediaForSession } from "../services/mediaIndex.ts";
import { createTopUp, portalActivityFor, portalCreditsFor } from "../services/portalCredits.ts";
import {
  eraseAll,
  listSessionFiles,
  resetConversation,
  resolveSessionFile,
  sessionAnalytics,
  wipeFiles,
  wipeMedia,
} from "../services/portalData.ts";
import { listPortalSkills } from "../services/portalSkills.ts";
import {
  type PortalCredits,
  type PortalMediaItem,
  type PortalNews,
  type PortalPageData,
  type PortalSkill,
  renderPortalPage,
  simplePage,
} from "../views/portalPage.ts";
import { portalIndexHtml } from "./portalStatic.ts";

type Deps = {
  secret: Buffer;
  prefs: GhostPrefsStore;
  crons: CronStore;
  state: StateStore;
  contacts: ContactBook;
  chatDb: import("../../../src/imessage/db.ts").ChatDb;
  config: Config;
  /** Generation-credit wallets. Absent ⇒ no Credits tab, no checkout. */
  credits?: CreditStore;
  /** dashboard/user-web/dist — the React portal. Absent or unbuilt ⇒ the
   *  server-rendered page is served instead. */
  spaIndexHtml?: string;
};

const PORTAL_EVENT_PREFIX = "[PORTAL_SCHEDULE]";
const MAX_PORTAL_JOBS = 10;

/**
 * USER self-service portal — no PIN; the standing per-user link IS the
 * credential (HMAC of the session key, see src/portal/token.ts). One link
 * controls exactly one chat. Surfaces:
 *
 *   GET  /u/:key/:token                       — multi-tab portal page
 *   GET  /u/:key/:token/file?p=<rel>[&dl=1]   — sandbox-scoped file serving
 *   POST /u/:key/:token/settings              — { enabled, activeHours, note }
 *   POST /u/:key/:token/cron/create           — user-authored schedule
 *   POST /u/:key/:token/cron/:id/pause|resume|cancel
 *   POST /u/:key/:token/privacy/:action       — wipe-media | wipe-files |
 *                                               reset-convo | erase-all
 */
export function portalRoutes(deps: Deps): Hono {
  const app = new Hono();
  // Two buckets: page+actions are cheap to abuse (strict), the media grid
  // legitimately fires dozens of file GETs per page load (generous). The
  // React portal costs two of the strict bucket per open (shell + data).
  const pageLimiter = new RateLimiter({ max: 60, windowMs: 60_000 });
  const fileLimiter = new RateLimiter({ max: 400, windowMs: 60_000 });
  const GONE = "This link is invalid. Ask Edmund to send you a fresh settings link.";

  const clientIp = (c: Parameters<Parameters<Hono["get"]>[1]>[0]): string =>
    // Behind the cloudflared tunnel every TCP peer is localhost — the real
    // client IP arrives in CF-Connecting-IP.
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";

  const auth = (
    c: Parameters<Parameters<Hono["get"]>[1]>[0],
    limiter: RateLimiter = pageLimiter,
  ): SessionKey | null => {
    if (!limiter.allow(clientIp(c))) return null;
    const { key, token } = c.req.param() as { key: string; token: string };
    return verifyPortalParts(
      deps.secret,
      key,
      token,
      deps.config.paths.data_dir,
    ) as SessionKey | null;
  };

  // ── page ──────────────────────────────────────────────────────────
  // The React portal (dashboard/user-web) when it has been built; the
  // server-rendered page otherwise, so a missing build degrades to the
  // old look rather than a blank screen.
  app.get("/:key/:token", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.html(simplePage(GONE), 404);
    const spa = deps.spaIndexHtml ? portalIndexHtml(deps.spaIndexHtml) : null;
    if (spa) {
      return new Response(Bun.file(spa), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const credits = await creditsFor(sessionKey);
    return c.html(renderPortalPage(buildPageData(deps, sessionKey, c.req.path, credits)));
  });

  // Everything the page shows, as JSON — what the React portal fetches.
  app.get("/:key/:token/data", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    const credits = await creditsFor(sessionKey);
    const basePath = c.req.path.replace(/\/data$/, "");
    return c.json(buildPageData(deps, sessionKey, basePath, credits));
  });

  // Best-effort like skills/news: a page that 500s because OpenRouter is
  // slow is worse than a page with an empty Credits tab.
  async function creditsFor(sessionKey: SessionKey): Promise<PortalCredits | null> {
    if (!deps.credits) return null;
    try {
      return await portalCreditsFor({ config: deps.config, store: deps.credits }, sessionKey);
    } catch (err) {
      console.error(`[portal] credits tab failed for ${sessionKey}:`, err);
      return null;
    }
  }

  // ── credits: the statement — OpenRouter's generations, Stripe's
  // payments, our refusals, balance after each. Slower than /data (several
  // OpenRouter reads), so the page fetches it after it has rendered.
  app.get("/:key/:token/credits/activity", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    if (!deps.credits) return c.json({ error: "credits are not in use" }, 403);
    try {
      const activity = await portalActivityFor(
        { config: deps.config, store: deps.credits },
        sessionKey,
      );
      if (!activity) return c.json({ error: "credits are not in use for this chat" }, 403);
      return c.json({ ok: true, activity });
    } catch (err) {
      console.error(`[portal] activity failed for ${sessionKey}:`, err);
      return c.json({ error: "OpenRouter could not be read just now" }, 503);
    }
  });

  // ── credits: start a Stripe checkout for this person ─────────────
  app.post("/:key/:token/credits/checkout", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    if (!deps.credits) return c.json({ error: "credits are not in use" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const r = await createTopUp(
      { config: deps.config, store: deps.credits },
      {
        sessionKey,
        amountUsd: body.amountUsd,
        portalAbsUrl: portalUrl(deps.config, deps.secret, sessionKey),
      },
    );
    if ("error" in r) return c.json({ error: r.error }, r.status);
    return c.json({ ok: true, url: r.url });
  });

  // ── sandbox-scoped file serving (media thumbnails + downloads) ────
  const INLINE_EXTS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".heic",
    ".mp4",
    ".mov",
    ".webm",
    ".m4v",
    ".caf",
    ".m4a",
    ".mp3",
    ".wav",
    ".flac",
    ".ogg",
    ".aac",
    ".pdf",
  ]);
  app.get("/:key/:token/file", (c) => {
    const sessionKey = auth(c, fileLimiter);
    if (!sessionKey) return c.text("not found", 404);
    const rel = c.req.query("p") ?? "";
    const abs = resolveSessionFile(sessionKey, rel);
    if (!abs) return c.text("not found", 404);
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    const name = abs.slice(abs.lastIndexOf("/") + 1).replace(/["\\\r\n]/g, "_");
    const headers: Record<string, string> = {
      // Never execute anything we serve — an HTML/SVG artifact opened
      // directly must not be able to script against the portal origin.
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    };
    const wantDownload = c.req.query("dl") === "1" || !INLINE_EXTS.has(ext);
    headers["Content-Disposition"] =
      `${wantDownload ? "attachment" : "inline"}; filename="${name}"`;
    return new Response(Bun.file(abs), { headers });
  });

  // ── settings ──────────────────────────────────────────────────────
  app.post("/:key/:token/settings", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    const body = await c.req.json().catch(() => ({}));

    const update: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") {
      update.enabled = body.enabled;
      update.disabledReason = body.enabled ? null : "turned off by the user via their portal";
      update.disabledAtMs = body.enabled ? null : Date.now();
    }
    const hours = parseActiveHours(body.activeHours);
    if (hours !== null) update.activeHours = hours;

    deps.prefs.upsert(sessionKey, {
      ...update,
      defaultsIfNew: {
        enabled: true,
        activeHours: DEFAULT_ACTIVE_HOURS_DM,
        timezone: deps.config.brown_nose.default_timezone,
        weeklyCap: resolveIntensity(deps.config.brown_nose.intensity).weeklyCap,
      },
    });
    if (typeof body.note === "string") deps.prefs.setUserNote(sessionKey, body.note);
    return c.json({ ok: true });
  });

  // ── schedules ─────────────────────────────────────────────────────
  app.post("/:key/:token/cron/create", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    const body = await c.req.json().catch(() => ({}));

    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 400) : "";
    if (!prompt) return c.json({ error: "describe what Edmund should do" }, 400);

    const mine = deps.crons
      .listForPortal(sessionKey)
      .filter((j) => j.systemEvent.startsWith(PORTAL_EVENT_PREFIX));
    if (mine.length >= MAX_PORTAL_JOBS) {
      return c.json(
        { error: `limit of ${MAX_PORTAL_JOBS} schedules reached — delete one first` },
        400,
      );
    }

    const schedule = buildSchedule(body);
    if (!schedule) return c.json({ error: "invalid schedule" }, 400);

    const audience = isGroupSession(sessionKey) ? "the group chat" : "the user";
    const job = deps.crons.create({
      sessionKey,
      systemEvent: `${PORTAL_EVENT_PREFIX} A recurring task the user set up THEMSELVES on their portal settings page (so it is always welcome — do not second-guess whether to send): "${prompt}". Do the task now and text the result to ${audience}.`,
      schedule,
    });
    return c.json({ ok: true, id: job.id, nextFireMs: job.nextFireMs });
  });

  app.post("/:key/:token/cron/:id/pause", (c) => cronAction(deps, c, "pause"));
  app.post("/:key/:token/cron/:id/resume", (c) => cronAction(deps, c, "resume"));
  app.post("/:key/:token/cron/:id/cancel", (c) => cronAction(deps, c, "cancel"));

  function cronAction(
    d: Deps,
    c: Parameters<Parameters<Hono["post"]>[1]>[0],
    act: "pause" | "resume" | "cancel",
  ) {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    const id = c.req.param("id");
    const job = d.crons.get(id);
    if (!job || job.sessionKey !== sessionKey) return c.json({ error: "no such job" }, 404);
    if (act === "cancel") {
      // Users may delete only schedules they created themselves — Edmund's
      // own reminders/flows are paused, not destroyed, from the portal.
      if (!job.systemEvent.startsWith(PORTAL_EVENT_PREFIX)) {
        return c.json(
          { error: "only your own schedules can be deleted — pause this one instead" },
          403,
        );
      }
      if (job.status === "paused") d.crons.resume(id); // cancel() only touches active rows
      return c.json({ ok: d.crons.cancel(id) });
    }
    return c.json({ ok: act === "pause" ? d.crons.pause(id) : d.crons.resume(id) });
  }

  // ── privacy ───────────────────────────────────────────────────────
  app.post("/:key/:token/privacy/:action", async (c) => {
    const sessionKey = auth(c);
    if (!sessionKey) return c.json({ error: "invalid link" }, 404);
    const action = c.req.param("action");
    // The link is the credential, so a deletion must also carry proof that a
    // person went through the dialog: the typed word for erase-all, an
    // explicit confirm flag for the rest. A bare POST does nothing.
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
    if (!privacyConfirmed(action, body.confirm)) {
      return c.json({ error: "confirmation required" }, 400);
    }
    try {
      switch (action) {
        case "wipe-media": {
          const r = wipeMedia(sessionKey);
          return c.json({
            ok: true,
            summary: `Deleted ${r.removed} media file${r.removed === 1 ? "" : "s"}`,
          });
        }
        case "wipe-files": {
          const r = wipeFiles(sessionKey);
          return c.json({
            ok: true,
            summary: `Deleted ${r.removed} file${r.removed === 1 ? "" : "s"}`,
          });
        }
        case "reset-convo": {
          resetConversation(deps.state, sessionKey);
          return c.json({
            ok: true,
            summary: "Conversation reset — Edmund starts fresh next message",
          });
        }
        case "erase-all": {
          const r = eraseAll({ sessionKey, ...deps });
          return c.json({
            ok: true,
            summary: `Erased: ${r.detail.join(", ") || "nothing to erase"}`,
          });
        }
        default:
          return c.json({ error: "unknown action" }, 400);
      }
    } catch (err) {
      console.error(`[portal] privacy ${action} failed for ${sessionKey}:`, err);
      return c.json({ error: "deletion failed — try again" }, 500);
    }
  });

  return app;
}

// ─── page data assembly ──────────────────────────────────────────────

function buildPageData(
  deps: Deps,
  sessionKey: SessionKey,
  path: string,
  credits: PortalCredits | null,
): PortalPageData {
  const isGroup = isGroupSession(sessionKey);
  const basePath = path.replace(/\/+$/, "");
  const label = sessionLabel(sessionKey, { contacts: deps.contacts, chatDb: deps.chatDb });
  const prefs = deps.prefs.get(sessionKey);
  const tz = prefs?.timezone ?? deps.config.brown_nose.default_timezone;

  let members: string[] = [];
  if (isGroup) {
    try {
      members = getGroupParticipants(deps.chatDb, chatIdFromKey(sessionKey)).map(
        (h) => deps.contacts.displayName(h) ?? h,
      );
    } catch {}
  }

  let personBody: string | null = null;
  if (!isGroup) {
    try {
      personBody = loadPersona(null, chatIdFromKey(sessionKey)).person?.body ?? null;
    } catch {}
  }

  const root = sandboxDir(sessionKey);
  const media: PortalMediaItem[] = listMediaForSession(sessionKey, {
    contacts: deps.contacts,
    chatDb: deps.chatDb,
  }).map((m) => ({
    rel: m.path.startsWith(`${root}/`) ? m.path.slice(root.length + 1) : m.path,
    name: m.path.slice(m.path.lastIndexOf("/") + 1),
    kind: m.kind,
    direction: m.direction,
    sizeBytes: m.sizeBytes,
    mtimeMs: m.mtimeMs,
  }));

  const files = listSessionFiles(sessionKey);
  const jobs = deps.crons
    .listForPortal(sessionKey)
    .filter((j) => !j.systemEvent.startsWith("[POKE") && !j.systemEvent.startsWith("Self-poke:"));

  // Skills this conversation can actually use, and the feature log. Both are
  // best-effort: a portal page that 500s because an announcement db is
  // missing is a worse failure than a page with an empty tab.
  let skills: PortalSkill[] = [];
  try {
    skills = listPortalSkills(sessionKey, {
      config: deps.config,
      chatDb: deps.chatDb,
      contacts: deps.contacts,
      chatGuids: chatGuidsForSession(sessionKey, deps.chatDb, deps.contacts),
      repoRoot: resolve(import.meta.dir, "..", "..", ".."),
    });
  } catch {}

  let whatsNew: PortalNews[] = [];
  try {
    const store = new AnnouncementStore(deps.config.paths.data_dir);
    try {
      whatsNew = store
        .liveAnnouncements()
        .reverse()
        .map((a) => ({ title: a.title, body: a.body, created_ms: a.created_ms }));
    } finally {
      store.close();
    }
  } catch {}

  const analytics = sessionAnalytics({
    sessionKey,
    chatDb: deps.chatDb,
    contacts: deps.contacts,
    prefs: deps.prefs,
    crons: deps.crons,
    mediaKinds: media.map((m) => m.kind),
    files,
  });

  return {
    basePath,
    ownerName: deps.config.owner?.name?.trim() || "the operator",
    label,
    isGroup,
    members,
    tz,
    enabled: prefs?.enabled ?? !isGroup,
    hours: prefs?.activeHours ?? (isGroup ? [] : DEFAULT_ACTIVE_HOURS_DM),
    note: prefs?.userNote ?? "",
    jobs,
    media,
    files,
    analytics,
    personBody,
    skills,
    whatsNew,
    credits,
  };
}

// ─── validation ──────────────────────────────────────────────────────

const DOWS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const DOW_NUM: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const HHMM = /^\d{1,2}:\d{2}$/;

function parseActiveHours(raw: unknown): ActiveHoursWindow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ActiveHoursWindow[] = [];
  for (const w of raw.slice(0, 14)) {
    if (!w || typeof w !== "object") return null;
    const { dow, start, end } = w as Record<string, unknown>;
    if (typeof dow !== "string" || !DOWS.has(dow)) return null;
    if (typeof start !== "string" || !HHMM.test(start)) return null;
    if (typeof end !== "string" || !HHMM.test(end)) return null;
    out.push({ dow: dow as ActiveHoursWindow["dow"], start, end });
  }
  return out;
}

/** Translate the portal form ({freq, atMs?, time?, dow?}) into a JobSchedule. */
export function buildSchedule(body: Record<string, unknown>): JobSchedule | null {
  const freq = typeof body.freq === "string" ? body.freq : "";
  if (freq === "once") {
    const atMs = typeof body.atMs === "number" ? body.atMs : Number.NaN;
    if (!Number.isFinite(atMs) || atMs <= Date.now() - 60_000) return null;
    if (atMs > Date.now() + 366 * 86_400_000) return null;
    return { kind: "once", atMs: Math.round(atMs) };
  }
  if (freq === "hourly") return { kind: "cron", expr: "0 * * * *" };

  const time = typeof body.time === "string" && HHMM.test(body.time) ? body.time : null;
  if (!time) return null;
  const [hRaw, mRaw] = time.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;

  if (freq === "daily") return { kind: "cron", expr: `${m} ${h} * * *` };
  if (freq === "weekly") {
    const dow = typeof body.dow === "string" ? DOW_NUM[body.dow] : undefined;
    if (dow === undefined) return null;
    return { kind: "cron", expr: `${m} ${h} * * ${dow}` };
  }
  return null;
}
