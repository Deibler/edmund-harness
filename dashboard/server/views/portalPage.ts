/**
 * HTML renderer for the USER self-service portal — a multi-tab, mobile-first
 * page served at /u/:key/:token (see routes/portal.ts).
 *
 * Tabs: Home (landing overview that routes everywhere) · Proactive ·
 * Media · Files · Artifacts · Schedules · Analytics · Memory (DMs only) ·
 * Tips · Privacy. Everything is rendered
 * server-side; a small inline script does tab switching, search filtering,
 * and the fetch() calls for actions. No frameworks, no external assets —
 * the page must work instantly over the tunnel on any phone.
 */

import type { CronJob } from "../../../src/cron/types.ts";
import type { ActiveHoursWindow } from "../../../src/ghost/prefs.ts";
import { isBrownNoseEvent } from "../../../src/proactive/queue.ts";
import type {
  PortalActivity,
  PortalActivityRow,
  PortalCredits,
} from "../services/portalCredits.ts";
import type { PortalAnalytics, PortalFile } from "../services/portalData.ts";

export type { PortalActivity, PortalActivityRow, PortalCredits };

export type PortalMediaItem = {
  rel: string;
  name: string;
  kind: "image" | "video" | "audio" | "other";
  direction: "generated" | "received";
  sizeBytes: number;
  mtimeMs: number;
};

export type PortalPageData = {
  basePath: string; // /u/<key>/<token>
  label: string;
  /** The operator's name from [owner].name, or "the operator". Every string
   *  that addresses the person about who runs this uses it. */
  ownerName: string;
  isGroup: boolean;
  members: string[];
  tz: string;
  enabled: boolean;
  hours: ActiveHoursWindow[];
  note: string;
  jobs: CronJob[];
  media: PortalMediaItem[];
  files: PortalFile[];
  analytics: PortalAnalytics;
  personBody: string | null; // DMs only
  skills: PortalSkill[];
  whatsNew: PortalNews[];
  /** Generation credit for this person; null when they have nothing to pay for. */
  credits: PortalCredits | null;
};

/** One row of the Skills tab. Mirrors services/portalSkills.ts. */
export type SkillGroup = "yours" | "public" | "curated" | "system";
export type PortalSkill = {
  name: string;
  description: string;
  group: SkillGroup;
  origin: string;
  needsConsent: boolean;
  mine: boolean;
};

/** One entry of the feature log, as shown to a person. */
export type PortalNews = { title: string; body: string; created_ms: number };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function simplePage(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edmund</title>${STYLE}</head><body><main class="wrap" style="padding-top:40px"><div class="card">${esc(body)}</div></main></body></html>`;
}

// ─── helpers ─────────────────────────────────────────────────────────

function fmtLocal(ms: number | null, tz: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function fmtDay(ms: number | null, tz: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(ms));
  } catch {
    return "—";
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const PORTAL_EVENT_PREFIX = "[PORTAL_SCHEDULE]";

function describeJob(job: CronJob, tz: string): { title: string; when: string; mine: boolean } {
  const mine = job.systemEvent.startsWith(PORTAL_EVENT_PREFIX);
  let title: string;
  if (isBrownNoseEvent(job.systemEvent)) {
    title = "Queued note from Edmund";
  } else if (mine) {
    const m = job.systemEvent.match(/"([\s\S]*)"/);
    title = m?.[1] ?? "Your scheduled task";
  } else {
    const cleaned = job.systemEvent.replace(/^\[[A-Z_]+\]/, "").trim();
    const head = cleaned.split("\n")[0] ?? cleaned;
    title = head.length > 140 ? `${head.slice(0, 139)}…` : head || "Scheduled task";
  }
  const when =
    job.schedule.kind === "once"
      ? `once · ${fmtLocal(job.schedule.atMs, tz)}`
      : `${cronWords(job.schedule.expr)} · next ${fmtLocal(job.nextFireMs, tz)}`;
  return { title, when, mine };
}

/** Translate the simple cron exprs the portal creates back into words. */
function cronWords(expr: string): string {
  const m = expr.match(/^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|\d)$/);
  if (!m) return `repeats (${expr})`;
  const [, min, hour, dow] = m;
  const t = (h: string) => {
    const hh = Number(h);
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  };
  if (hour === "*") return "every hour";
  if (dow === "*") return `daily at ${t(hour as string)}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `every ${days[Number(dow)]} at ${t(hour as string)}`;
}

// ─── style ───────────────────────────────────────────────────────────

const STYLE = `<style>
:root{
  color-scheme:dark;
  --bg:#0b0d12;--panel:#141821;--panel2:#1a1f2b;--line:#252b3a;--line2:#2e3548;
  --text:#e9ecf3;--dim:#9aa3b6;--faint:#6e7790;
  --accent:#5b8cff;--accent2:#3f6fe8;--good:#34c759;--warn:#ffb340;--bad:#ff5b5b;
  --radius:14px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:var(--accent);text-decoration:none}
.top{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:12px;padding:12px 16px;background:rgba(11,13,18,.86);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.top .brand{font-weight:700;font-size:1.05rem;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top .brand b{color:var(--text);letter-spacing:.3px}
.top .brand span{color:var(--dim);font-weight:500;font-size:.9rem}
#menu-btn{appearance:none;border:1px solid var(--line2);background:var(--panel);border-radius:10px;width:38px;height:38px;cursor:pointer;flex:none;display:none;align-items:center;justify-content:center}
.bars{display:flex;flex-direction:column;gap:4px;width:16px;margin:0 auto}
.bars span{display:block;height:1.5px;border-radius:2px;background:var(--text)}
nav.tabs{display:flex;gap:6px;padding:10px 16px;overflow-x:auto;scrollbar-width:none;position:sticky;top:63px;z-index:30;background:rgba(11,13,18,.86);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs a{flex:none;padding:7px 14px;border-radius:999px;font-size:.86rem;font-weight:600;color:var(--dim);border:1px solid transparent}
nav.tabs a.active{color:#fff;background:var(--panel2);border-color:var(--line2)}
#scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:45;opacity:0;pointer-events:none;transition:.2s}
#drawer{position:fixed;top:0;left:0;bottom:0;width:270px;max-width:82vw;background:var(--panel);border-right:1px solid var(--line);z-index:50;transform:translateX(-102%);transition:transform .22s ease;padding:18px 12px;overflow-y:auto}
#drawer .dh{font-weight:700;font-size:1.1rem;padding:4px 10px 14px}
#drawer a{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:10px;color:var(--dim);font-weight:600;font-size:.95rem}
#drawer a.active{color:#fff;background:var(--panel2)}
#drawer a .ico{width:22px;text-align:center}
body.menu-open #drawer{transform:none}
body.menu-open #scrim{opacity:1;pointer-events:auto}
.wrap{max-width:760px;margin:0 auto;padding:18px 14px 80px}
.tab{display:none}.tab.active{display:block}
h1{font-size:1.3rem;margin:6px 4px 2px}
.sub{color:var(--dim);font-size:.88rem;margin:0 4px 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:14px}
.card h2{font-size:1rem;margin-bottom:4px}
.card .cap{font-size:.8rem;color:var(--faint);margin-bottom:10px}
.card p{font-size:.9rem;color:var(--dim);margin-bottom:8px}
.hint{font-size:.8rem;color:var(--faint)}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:none}
label{font-size:.92rem}
input[type=time],input[type=datetime-local],select,input[type=search],input[type=text]{background:var(--bg);color:var(--text);border:1px solid var(--line2);border-radius:9px;padding:8px 10px;font-size:16px;font-family:inherit}
input[type=search]{width:100%}
textarea{width:100%;min-height:84px;background:var(--bg);color:var(--text);border:1px solid var(--line2);border-radius:10px;padding:10px;font-size:16px;font-family:inherit;resize:vertical}
button{appearance:none;border:none;border-radius:10px;padding:11px 16px;font-size:.93rem;font-weight:650;cursor:pointer;font-family:inherit}
.primary{background:var(--accent);color:#fff;width:100%;margin-top:12px}
.primary:active{background:var(--accent2)}
.ghostbtn{background:var(--panel2);color:var(--text);border:1px solid var(--line2);padding:8px 12px;font-size:.83rem}
.danger{background:#3a1518;color:#ff8585;border:1px solid #5c2125;width:100%;margin-top:10px}
.switch{position:relative;width:51px;height:31px;flex:none}
.switch input{display:none}
.slider{position:absolute;inset:0;background:#3a4256;border-radius:999px;transition:.15s;cursor:pointer}
.slider:before{content:"";position:absolute;width:25px;height:25px;border-radius:50%;background:#fff;top:3px;left:3px;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.switch input:checked + .slider{background:var(--good)}
.switch input:checked + .slider:before{transform:translateX(20px)}
pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;max-height:420px;overflow:auto;color:#c4ccd9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.doc{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:26px 22px;margin-bottom:14px;font-size:.92rem;color:#c9d1de;line-height:1.7;overflow-wrap:break-word}
.doc h2{font-size:1.35rem;margin:0 0 14px;color:var(--text);letter-spacing:-.3px}
.doc h3{font-size:1.02rem;margin:26px 0 10px;color:var(--text);padding-bottom:7px;border-bottom:1px solid var(--line)}
.doc h3:first-child,.doc h2+h3{margin-top:14px}
.doc h4,.doc h5{font-size:.92rem;margin:18px 0 8px;color:var(--text)}
.doc p{margin:0 0 11px}
.doc ul{margin:2px 0 14px;padding-left:20px}
.doc li{margin:0 0 7px}
.doc strong{color:var(--text);font-weight:650}
.doc em{color:var(--dim)}
.doc code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.84em;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.doc hr{border:none;border-top:1px solid var(--line);margin:18px 0}
.badge{display:inline-block;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--panel2);color:var(--dim);margin-left:6px;vertical-align:1px}
.badge.green{background:#11301d;color:#54d878}
.badge.amber{background:#33260e;color:#ffb340}
.ok-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);background:#1c2433;color:#fff;border:1px solid var(--line2);font-weight:600;font-size:.88rem;padding:11px 20px;border-radius:999px;opacity:0;transition:.22s;pointer-events:none;z-index:60;max-width:88vw;text-align:center}
.ok-toast.show{opacity:1;transform:translateX(-50%)}
.day{display:grid;grid-template-columns:36px 52px minmax(0,1fr) minmax(0,1fr);align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid var(--line)}
.day:last-child{border-bottom:none}
.day .nm{font-size:.84rem;color:var(--dim);text-transform:uppercase;font-weight:700}
.day input[type=time]{width:100%;min-width:0;padding:8px 6px}
.muted{opacity:.4;pointer-events:none}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.chip{padding:6px 12px;border-radius:999px;font-size:.8rem;font-weight:650;background:var(--panel2);color:var(--dim);border:1px solid var(--line2);cursor:pointer}
.chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}
.tile{background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tile img{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#000}
.tile video{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#000}
.tile .meta{padding:7px 9px;font-size:.7rem;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.audio{grid-column:1/-1}
.tile.audio .inner{padding:10px}
.tile audio{width:100%;margin-top:6px}
.flist .frow{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.flist .frow:last-child{border-bottom:none}
.flist .fico{min-width:44px;height:30px;padding:0 6px;border-radius:8px;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:.66rem;font-weight:700;letter-spacing:.5px;color:var(--dim);flex:none}
.flist .fmain{min-width:0;flex:1}
.flist .fname{font-size:.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flist .fsub{font-size:.74rem;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat{display:block;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:13px 14px;color:var(--text)}
.stat .v{font-size:1.45rem;font-weight:750;letter-spacing:-.5px}
.stat .k{font-size:.74rem;color:var(--faint);margin-top:2px}
.hero{padding:10px 4px 16px}
.hero h1{margin:2px 0 6px;font-size:1.5rem;letter-spacing:-.3px}
.overline{font-size:.7rem;font-weight:750;letter-spacing:1.4px;text-transform:uppercase;color:var(--accent)}
.quick{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.quick .stat{background:var(--panel);transition:border-color .15s}
.quick .stat:active,.quick .stat:hover{border-color:var(--line2)}
.navcards{display:grid;grid-template-columns:1fr;gap:9px}
@media (min-width:560px){.navcards{grid-template-columns:1fr 1fr}}
.navcard{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:13px 15px;color:var(--text);transition:border-color .15s,background .15s}
.navcard:hover,.navcard:active{border-color:var(--accent);background:var(--panel2)}
.navcard .nc-main{min-width:0;flex:1}
.navcard b{display:block;font-size:.93rem}
.navcard span{display:block;font-size:.77rem;color:var(--faint);line-height:1.4;margin-top:2px}
.navcard .nc-arrow{color:var(--faint);font-size:1.3rem;font-weight:300;flex:none}
.jobs .row{align-items:flex-start}
.jobs .t{font-size:.9rem;font-weight:600}
.jobs .w{font-size:.76rem;color:var(--faint);margin-top:2px}
.jobs .acts{display:flex;gap:6px;flex:none}
.empty{padding:26px 0;text-align:center;color:var(--faint);font-size:.88rem}
.tipline{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.tipline:last-child{border-bottom:none}
.tipline b{display:block;font-size:.9rem}
.tipline span{font-size:.82rem;color:var(--dim)}
fieldset{border:none;margin-top:10px}
.formrow{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.formrow label{color:var(--dim);font-size:.85rem;min-width:70px}
@media (max-width:719px){
  #menu-btn{display:flex}
  nav.tabs{display:none}
}
@media (min-width:720px){
  .wrap{padding-top:24px}
}
</style>`;

// ─── tabs ────────────────────────────────────────────────────────────

const TAB_DEFS: Array<{ id: string; name: string; desc: string; dmOnly?: boolean }> = [
  { id: "home", name: "Home", desc: "Overview of everything on this page." },
  {
    id: "proactive",
    name: "Proactive",
    desc: "Whether and when Edmund may text first, plus a standing note he always reads.",
  },
  {
    id: "credits",
    name: "Credits",
    desc: "Your prepaid balance for images, videos and audio, and how to add to it.",
    dmOnly: true,
  },
  {
    id: "media",
    name: "Media",
    desc: "Every image, video, and voice memo from this conversation, searchable.",
  },
  {
    id: "files",
    name: "Files",
    desc: "Edmund's working files for this chat, with downloads.",
  },
  {
    id: "artifacts",
    name: "Artifacts",
    desc: "Finished documents and write-ups he has produced.",
  },
  {
    id: "skills",
    name: "Skills",
    desc: "Everything Edmund knows how to do, and who taught him.",
  },
  {
    id: "whatsnew",
    name: "What's new",
    desc: "Capabilities Edmund has picked up recently.",
  },
  {
    id: "schedules",
    name: "Schedules",
    desc: "Recurring tasks and reminders — pause, resume, or create your own.",
  },
  {
    id: "analytics",
    name: "Analytics",
    desc: "Message volume, proactive-message outcomes, and workspace stats.",
  },
  {
    id: "memory",
    name: "Memory",
    desc: "The private notes Edmund keeps about you, in full.",
    dmOnly: true,
  },
  {
    id: "tips",
    name: "Tips & Help",
    desc: "How to get the best results out of Edmund.",
  },
  {
    id: "privacy",
    name: "Privacy & Data",
    desc: "What is stored for this chat, and tools to delete it.",
  },
];

export function renderPortalPage(d: PortalPageData): string {
  const tabs = TAB_DEFS.filter(
    (t) => (!t.dmOnly || !d.isGroup) && (t.id !== "credits" || d.credits !== null),
  );
  const navLinks = (cls: string) =>
    tabs
      .map(
        (t) =>
          `<a href="#${t.id}" data-tab="${t.id}" class="${cls === "drawer" ? "" : ""}">${t.name}</a>`,
      )
      .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Edmund · ${esc(d.label)}</title>
${STYLE}
</head>
<body>
<header class="top">
  <button id="menu-btn" aria-label="Menu"><span class="bars"><span></span><span></span><span></span></span></button>
  <div class="brand"><b>Edmund</b> <span>· ${esc(d.label)}${d.isGroup ? " (group)" : ""}</span></div>
</header>
<nav class="tabs" id="tabbar">${navLinks("bar")}</nav>
<div id="scrim"></div>
<aside id="drawer"><div class="dh">Edmund</div>${navLinks("drawer")}</aside>

<main class="wrap">
  ${overviewTab(d)}
  ${proactiveTab(d)}
  ${d.credits ? creditsTab(d, d.credits) : ""}
  ${mediaTab(d)}
  ${filesTab(d)}
  ${artifactsTab(d)}
  ${skillsTab(d)}
  ${whatsNewTab(d)}
  ${schedulesTab(d)}
  ${analyticsTab(d)}
  ${d.isGroup ? "" : memoryTab(d)}
  ${tipsTab(d)}
  ${privacyTab(d)}
</main>
<div class="ok-toast" id="toast">Saved</div>
${script(d)}
</body>
</html>`;
}

// ─── tab: home / overview ────────────────────────────────────────────

function overviewTab(d: PortalPageData): string {
  const a = d.analytics;
  const who = d.isGroup ? "this group" : "you";
  const memberLine =
    d.isGroup && d.members.length > 0
      ? `<p class="hint" style="margin:6px 4px 0">In this group: ${esc(d.members.join(", "))}</p>`
      : "";
  const navCards = TAB_DEFS.filter((t) => t.id !== "home" && (!t.dmOnly || !d.isGroup))
    .map(
      (t) => `<a class="navcard" href="#${t.id}">
        <div class="nc-main"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>
        <div class="nc-arrow">›</div>
      </a>`,
    )
    .join("");

  return `<section class="tab" id="tab-home">
  <div class="hero">
    <div class="overline">Personal portal</div>
    <h1>${esc(d.label)}</h1>
    <p class="sub" style="margin-bottom:0">Everything Edmund keeps and does for this one conversation — settings, media, files, schedules, stats, and privacy controls. Nothing from any other chat is shown here.</p>
    ${memberLine}
  </div>

  <div class="quick">
    <a class="stat" href="#analytics"><div class="v">${a.messages.total.toLocaleString()}</div><div class="k">messages</div></a>
    <a class="stat" href="#media"><div class="v">${(a.media.images + a.media.videos + a.media.audio).toLocaleString()}</div><div class="k">media items</div></a>
    <a class="stat" href="#schedules"><div class="v">${a.schedules.active}</div><div class="k">active schedules</div></a>
  </div>

  <div class="overline" style="margin:18px 4px 8px">Browse</div>
  <div class="navcards">${navCards}</div>

  <div class="card" style="margin-top:18px">
    <h2>About Edmund</h2>
    <p>Edmund is the assistant in ${who === "you" ? "your" : "this group's"} texts. Ask him anything; send photos, documents, and voice memos; have him research, build, schedule, and remember. Besides answering when ${who === "you" ? "you write" : "someone writes"}, he can also reach out on his own when he has something genuinely worth sharing — that behavior is fully under your control on the Proactive tab.</p>
    <p class="hint">House rules for unprompted messages: he never sends a second one while the first sits unanswered, he only texts inside the hours you allow, and the timing is deliberately irregular — he is a friend with something to say, not a notification trying to pull you back.</p>
  </div>

  <div class="card">
    <h2>About this page</h2>
    <p class="hint">This link is permanent and private to this conversation — the address itself is the key, so treat it like a password and don't forward it. If you ever lose it, text Edmund "send me my portal link" and he'll send a fresh one. Changes you make here take effect immediately.</p>
  </div>
</section>`;
}

// ─── tab: proactive settings ─────────────────────────────────────────

function proactiveTab(d: PortalPageData): string {
  const dows: Array<ActiveHoursWindow["dow"]> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const hourRows = dows
    .map((dow) => {
      const w = d.hours.find((h) => h.dow === dow);
      const on = w !== undefined;
      return `<div class="day" data-dow="${dow}">
        <span class="nm">${dow}</span>
        <label class="switch"><input type="checkbox" class="day-on" ${on ? "checked" : ""}><span class="slider"></span></label>
        <input type="time" class="day-start ${on ? "" : "muted"}" value="${esc(w?.start ?? "09:00")}">
        <input type="time" class="day-end ${on ? "" : "muted"}" value="${esc(w?.end ?? "21:00")}">
      </div>`;
    })
    .join("");

  return `<section class="tab" id="tab-proactive">
  <h1>Proactive messages</h1>
  <p class="sub">Control whether and when Edmund may text ${d.isGroup ? "this group" : "you"} first. Replies to ${d.isGroup ? "the group" : "you"} are never limited by these settings.</p>

  <div class="card">
    <h2>Master switch</h2>
    <div class="row">
      <label for="bn-on"><b>Let Edmund reach out unprompted</b><br><span class="hint">Off = he only ever replies when ${d.isGroup ? "someone in the group texts" : "you text"} first.</span></label>
      <label class="switch"><input type="checkbox" id="bn-on" ${d.enabled ? "checked" : ""}><span class="slider"></span></label>
    </div>
  </div>

  <div class="card">
    <h2>Hours he's allowed to text</h2>
    <p class="cap">Toggle a day off to block it entirely. Times are ${esc(d.tz)}. Replies to ${d.isGroup ? "the group" : "you"} are always allowed, any time — this only limits messages he starts.</p>
    ${hourRows}
  </div>

  <div class="card">
    <h2>A note to Edmund</h2>
    <p class="cap">Your own words — he reads this every time he considers reaching out. ("Only message me about fishing and the weather", "never before noon", "more memes".)</p>
    <textarea id="bn-note" maxlength="2000" placeholder="Anything you want Edmund to know about contacting ${d.isGroup ? "this group" : "you"}…">${esc(d.note)}</textarea>
    <button class="primary" id="save">Save settings</button>
  </div>
</section>`;
}

// ─── tab: credits ────────────────────────────────────────────────────

function money(n: number | null): string {
  return n === null ? "—" : `$${n.toFixed(2)}`;
}

function creditsTab(d: PortalPageData, c: PortalCredits): string {
  const presets = c.presets
    .map(
      (p) =>
        `<button class="primary" data-topup="${p}" ${c.checkoutReady && !c.disabled ? "" : "disabled"}>Add $${p}</button>`,
    )
    .join(" ");
  const rows = c.payments
    .map((p) => {
      const when = new Date(p.atMs).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: d.tz,
      });
      const what = `Paid ${money(p.paidUsd)} → ${money(p.creditedUsd)} credit`;
      const receipt = p.receiptUrl
        ? `<a class="hint" href="${esc(p.receiptUrl)}" target="_blank" rel="noopener">receipt</a>`
        : "";
      return `<div class="row"><span>${esc(when)} · ${esc(what)}</span>${receipt}</div>`;
    })
    .join("");
  const status = c.disabled
    ? `<p class="cap">Generation is paused for you right now. ${esc(d.ownerName)} can turn it back on.</p>`
    : c.unavailable
      ? `<p class="cap">${esc(c.unavailable)}. Your balance is safe; try reloading in a minute.</p>`
      : "";
  const pct = Math.round(c.ratio * 100);
  return `<section class="tab" id="tab-credits">
  <h1>Credits</h1>
  <p class="sub">Images, videos and audio Edmund makes for you run on prepaid credit that is yours alone. Everything else he does is unaffected by this balance.</p>

  <div class="card">
    <h2>Your balance</h2>
    <div class="statgrid">
      <div class="stat"><div class="v">${money(c.remainingUsd)}</div><div class="k">available now</div></div>
      <div class="stat"><div class="v">${money(c.usageUsd)}</div><div class="k">spent so far</div></div>
      <div class="stat"><div class="v">${money(c.creditedTotalUsd)}</div><div class="k">added in total</div></div>
    </div>
    ${status}
    <p class="hint">A typical image costs a few cents; a short video can run a few dollars. Edmund tells you what each one cost and warns you when you're running low.</p>
  </div>

  <div class="card">
    <h2>Add credit</h2>
    <p class="cap">Card payment through Stripe. Each $1 paid becomes $${(c.ratio).toFixed(2)} of credit — the difference is the card and provider fees, passed through at cost. Minimum $${c.minTopup.toFixed(0)}.</p>
    <div class="chips" id="topup-presets">${presets}</div>
    <div class="row">
      <label for="topup-custom"><b>Another amount</b><br><span class="hint">$${c.minTopup.toFixed(0)}–$${c.maxTopup.toFixed(0)}, becomes ${pct}% credit</span></label>
      <span style="display:flex;gap:6px;align-items:center">
        <input type="number" id="topup-custom" min="${c.minTopup}" max="${c.maxTopup}" step="1" placeholder="${c.minTopup}" style="width:90px">
        <button class="primary" id="topup-go" ${c.checkoutReady && !c.disabled ? "" : "disabled"}>Add</button>
      </span>
    </div>
    ${c.checkoutReady ? "" : `<p class="cap">Card payments aren't switched on yet — ask ${esc(d.ownerName)}.</p>`}
    <p class="hint">After you pay, the credit lands within about a minute and Edmund picks up where he left off.</p>
  </div>

  <div class="card">
    <h2>History</h2>
    ${rows || `<p class="hint">Nothing yet.</p>`}
  </div>
</section>`;
}

// ─── tab: media ──────────────────────────────────────────────────────

function fileUrl(base: string, rel: string, dl = false): string {
  return `${base}/file?p=${encodeURIComponent(rel)}${dl ? "&dl=1" : ""}`;
}

function mediaTab(d: PortalPageData): string {
  const tiles = d.media
    .map((m) => {
      const q = esc(`${m.name} ${m.kind} ${m.direction}`.toLowerCase());
      const url = fileUrl(d.basePath, m.rel);
      const meta = `${m.direction === "generated" ? "Edmund" : "sent in"} · ${fmtDay(m.mtimeMs, d.tz)} · ${fmtBytes(m.sizeBytes)}`;
      if (m.kind === "image") {
        return `<a class="tile" data-kind="image" data-dir="${m.direction}" data-q="${q}" href="${url}" target="_blank" rel="noopener"><img loading="lazy" src="${url}" alt="${esc(m.name)}"><div class="meta">${esc(meta)}</div></a>`;
      }
      if (m.kind === "video") {
        return `<div class="tile" data-kind="video" data-dir="${m.direction}" data-q="${q}"><video preload="none" controls playsinline src="${url}"></video><div class="meta">${esc(meta)}</div></div>`;
      }
      if (m.kind === "audio") {
        return `<div class="tile audio" data-kind="audio" data-dir="${m.direction}" data-q="${q}"><div class="inner"><div class="fname" style="font-size:.85rem;font-weight:600">${esc(m.name)}</div><audio preload="none" controls src="${url}"></audio><div class="meta" style="padding:4px 0 0">${esc(meta)}</div></div></div>`;
      }
      return `<a class="tile audio" data-kind="other" data-dir="${m.direction}" data-q="${q}" href="${fileUrl(d.basePath, m.rel, true)}"><div class="inner"><div class="fname" style="font-size:.85rem;font-weight:600">${esc(m.name)}</div><div class="meta" style="padding:4px 0 0">${esc(meta)} · tap to download</div></div></a>`;
    })
    .join("");

  return `<section class="tab" id="tab-media">
  <h1>Media</h1>
  <p class="sub">Every photo, video, and voice memo from this conversation — both things Edmund made for ${d.isGroup ? "the group" : "you"} and things ${d.isGroup ? "members" : "you"} sent him. Tap any image to open it full size.</p>
  <div class="card">
    <input type="search" id="media-q" placeholder="Search media by name…">
    <div class="chips" id="media-chips">
      <span class="chip active" data-f="all">All</span>
      <span class="chip" data-f="image">Images</span>
      <span class="chip" data-f="video">Videos</span>
      <span class="chip" data-f="audio">Voice</span>
      <span class="chip" data-f="other">Other</span>
      <span class="chip" data-f="dir:generated">Made by Edmund</span>
      <span class="chip" data-f="dir:received">Sent to him</span>
    </div>
    ${d.media.length === 0 ? `<div class="empty">Nothing yet — ask Edmund to make you an image, a video, or a voice memo and it'll show up here.</div>` : `<div class="grid" id="media-grid">${tiles}</div><div class="empty" id="media-none" style="display:none">No matches.</div>`}
  </div>
</section>`;
}

// ─── tab: skills ─────────────────────────────────────────────────────

function skillRow(sk: PortalSkill): string {
  const q = esc(`${sk.name} ${sk.description} ${sk.origin}`.toLowerCase());
  // A published skill this chat has not agreed to is labelled rather than
  // hidden: the point of the page is that someone can see a skill exists and
  // ask for it. Agreeing happens in the conversation, not here — a consent
  // granted by clicking a link is not the person answering Edmund.
  const badge = sk.needsConsent
    ? `<span class="pill" style="opacity:.75">ask Edmund to use it</span>`
    : "";
  return `<div class="frow" data-q="${q}">
    <div class="fmain">
      <div class="fname">${esc(sk.name)} ${badge}</div>
      <div class="fsub">${esc(sk.origin)}${sk.description ? ` · ${esc(sk.description)}` : ""}</div>
    </div>
  </div>`;
}

/**
 * Sections, in the order a reader cares about them.
 *
 * Each carries a sentence saying where that group came from. Provenance is
 * the one thing a person browsing this page cannot work out for themselves,
 * and it changes what they can assume: a stock skill shipped with Edmund, a
 * curated one he wrote from a pattern he noticed, a public one belongs to
 * somebody they may know.
 */
const SKILL_GROUPS: Array<{ id: SkillGroup; name: string; blurb: string }> = [
  {
    id: "yours",
    name: "Yours",
    blurb: "Grown out of this conversation. Nobody else sees these unless you share them.",
  },
  {
    id: "public",
    name: "Shared by other people",
    blurb:
      "Someone else wrote these and published them. The first time one comes up, Edmund will ask before using it — unless the person who wrote it is in the chat.",
  },
  {
    id: "curated",
    name: "Learned",
    blurb:
      "Edmund noticed the same job coming up across separate conversations and worked out a method for it. Written from the shape of the requests, never from anyone's details.",
  },
  {
    id: "system",
    name: "Built in",
    blurb: "The standard kit — these ship with Edmund.",
  },
];

function skillsTab(d: PortalPageData): string {
  const sections = SKILL_GROUPS.map((g) => {
    const items = d.skills.filter((s) => s.group === g.id);
    if (items.length === 0) return "";
    return `<div class="fsub" style="padding:14px 0 2px;font-weight:600;color:#fff">${g.name} <span style="font-weight:400;opacity:.7">· ${items.length} skill${items.length === 1 ? "" : "s"}</span></div>
      <div class="fsub" style="padding:0 0 6px">${esc(g.blurb)}</div>
      ${items.map(skillRow).join("")}`;
  }).join("");

  return `<section class="tab" id="tab-skills">
  <h1>Skills</h1>
  <p class="sub">The things Edmund has a worked-out method for. You never have to name one — just ask for what you want and he picks. This is here so you can see what is possible, and where each one came from.</p>
  <div class="card">
    <input type="search" id="skills-q" placeholder="Search skills…">
    ${
      d.skills.length === 0
        ? `<div class="empty">Nothing to show yet.</div>`
        : `<div class="flist" id="skills-list" style="margin-top:8px">${sections}</div><div class="empty" id="skills-none" style="display:none">No matches.</div>`
    }
  </div>
</section>`;
}

// ─── tab: what's new ─────────────────────────────────────────────────

function whatsNewTab(d: PortalPageData): string {
  const items = d.whatsNew
    .map(
      (n) => `<div class="frow">
      <div class="fmain">
        <div class="fname">${esc(n.title)}</div>
        <div class="fsub">${esc(n.body)}</div>
      </div>
    </div>`,
    )
    .join("");
  return `<section class="tab" id="tab-whatsnew">
  <h1>What's new</h1>
  <p class="sub">Capabilities Edmund has picked up recently.</p>
  <div class="card">
    ${d.whatsNew.length === 0 ? `<div class="empty">Nothing new right now.</div>` : `<div class="flist">${items}</div>`}
  </div>
</section>`;
}

// ─── tabs: files & artifacts ─────────────────────────────────────────

// The workspace can contain vendored source trees with thousands of files.
// Keep the page payload bounded; the full list still feeds analytics, while
// the UI shows the newest useful slice instead of freezing mobile Safari.
const MAX_FILE_ROWS = 500;

function fileRow(base: string, tz: string, f: PortalFile): string {
  const ico = esc(f.ext.replace(".", "").toUpperCase().slice(0, 4) || "FILE");
  const q = esc(`${f.relPath}`.toLowerCase());
  return `<div class="frow" data-q="${q}">
    <div class="fico">${ico}</div>
    <div class="fmain">
      <div class="fname">${esc(f.name)}</div>
      <div class="fsub">${f.dir ? `${esc(f.dir)} · ` : ""}${fmtBytes(f.sizeBytes)} · ${fmtDay(f.mtimeMs, tz)}</div>
    </div>
    <a class="ghostbtn" style="text-decoration:none" href="${fileUrl(base, f.relPath, true)}">Download</a>
  </div>`;
}

function filesTab(d: PortalPageData): string {
  const shown = d.files.slice(0, MAX_FILE_ROWS);
  const rows = shown.map((f) => fileRow(d.basePath, d.tz, f)).join("");
  const truncated = d.files.length - shown.length;
  return `<section class="tab" id="tab-files">
  <h1>Files</h1>
  <p class="sub">Edmund's private workspace for this conversation — every working file he's created or saved while helping ${d.isGroup ? "the group" : "you"}. Photos and videos live on the Media tab.</p>
  <div class="card">
    <input type="search" id="files-q" placeholder="Search files…">
    ${d.files.length === 0 ? `<div class="empty">No files yet. When Edmund works on something for ${d.isGroup ? "this group" : "you"} — notes, research, a webpage — it lands here.</div>` : `${truncated > 0 ? `<p class="hint" style="margin-top:9px">Showing the newest ${shown.length.toLocaleString()} files. ${truncated.toLocaleString()} older working files remain in the workspace.</p>` : ""}<div class="flist" id="files-list" style="margin-top:8px">${rows}</div><div class="empty" id="files-none" style="display:none">No matches.</div>`}
  </div>
</section>`;
}

function artifactsTab(d: PortalPageData): string {
  const arts = d.files.filter((f) => f.isArtifact);
  const shown = arts.slice(0, MAX_FILE_ROWS);
  const rows = shown.map((f) => fileRow(d.basePath, d.tz, f)).join("");
  const truncated = arts.length - shown.length;
  return `<section class="tab" id="tab-artifacts">
  <h1>Artifacts</h1>
  <p class="sub">Finished things Edmund produced — documents, write-ups, pages, spreadsheets. A filtered view of the Files tab showing just the readable results.</p>
  <div class="card">
    <input type="search" id="arts-q" placeholder="Search artifacts…">
    ${arts.length === 0 ? `<div class="empty">No artifacts yet — ask Edmund to research or write something up and the result appears here.</div>` : `${truncated > 0 ? `<p class="hint" style="margin-top:9px">Showing the newest ${shown.length.toLocaleString()} artifacts. ${truncated.toLocaleString()} older items remain in the workspace.</p>` : ""}<div class="flist" id="arts-list" style="margin-top:8px">${rows}</div><div class="empty" id="arts-none" style="display:none">No matches.</div>`}
  </div>
</section>`;
}

// ─── tab: schedules ──────────────────────────────────────────────────

function schedulesTab(d: PortalPageData): string {
  const jobs = d.jobs;
  const jobRows =
    jobs.length === 0
      ? `<div class="empty">Nothing scheduled right now.</div>`
      : jobs
          .map((j) => {
            const desc = describeJob(j, d.tz);
            const paused = j.status === "paused";
            return `<div class="row">
              <div style="min-width:0">
                <div class="t">${esc(desc.title)}${paused ? '<span class="badge amber">paused</span>' : ""}${desc.mine ? '<span class="badge">yours</span>' : ""}</div>
                <div class="w">${esc(desc.when)}</div>
              </div>
              <div class="acts">
                <button class="ghostbtn" data-job="${esc(j.id)}" data-act="${paused ? "resume" : "pause"}">${paused ? "Resume" : "Pause"}</button>
                ${desc.mine ? `<button class="ghostbtn" style="color:#ff8585" data-job="${esc(j.id)}" data-act="cancel">Delete</button>` : ""}
              </div>
            </div>`;
          })
          .join("");

  return `<section class="tab" id="tab-schedules">
  <h1>Schedules</h1>
  <p class="sub">Recurring tasks and reminders for this chat. Pause stops one without deleting it. You can also just text Edmund "remind me…" — he'll set these up himself.</p>

  <div class="card jobs">
    <h2>Scheduled</h2>
    ${jobRows}
  </div>

  <div class="card">
    <h2>Create a schedule</h2>
    <p class="cap">Tell Edmund what to do and when. When it fires, he does the work and texts ${d.isGroup ? "the group" : "you"} the result.</p>
    <textarea id="sch-prompt" maxlength="400" placeholder="e.g. Send me the weather forecast and anything interesting happening in Lancaster today"></textarea>
    <div class="formrow">
      <label for="sch-freq">Repeats</label>
      <select id="sch-freq">
        <option value="once">Once</option>
        <option value="hourly">Every hour</option>
        <option value="daily" selected>Daily</option>
        <option value="weekly">Weekly</option>
      </select>
    </div>
    <div class="formrow" id="sch-when-once" style="display:none">
      <label for="sch-at">When</label>
      <input type="datetime-local" id="sch-at">
    </div>
    <div class="formrow" id="sch-when-dow" style="display:none">
      <label for="sch-dow">Day</label>
      <select id="sch-dow"><option value="mon">Monday</option><option value="tue">Tuesday</option><option value="wed">Wednesday</option><option value="thu">Thursday</option><option value="fri">Friday</option><option value="sat">Saturday</option><option value="sun">Sunday</option></select>
    </div>
    <div class="formrow" id="sch-when-time">
      <label for="sch-time">At</label>
      <input type="time" id="sch-time" value="09:00">
      <span class="hint">${esc(d.tz)}</span>
    </div>
    <button class="primary" id="sch-create">Create schedule</button>
    <p class="hint" style="margin-top:8px">Limit: 10 schedules of your own per chat. Hourly schedules fire on the hour.</p>
  </div>
</section>`;
}

// ─── tab: analytics ──────────────────────────────────────────────────

function analyticsTab(d: PortalPageData): string {
  const a = d.analytics;
  const engageRate =
    a.proactive.total > 0 ? `${Math.round((a.proactive.engaged / a.proactive.total) * 100)}%` : "—";
  return `<section class="tab" id="tab-analytics">
  <h1>Analytics</h1>
  <p class="sub">${d.isGroup ? "This group's" : "Your"} stats with Edmund, computed live from this conversation only.</p>

  <div class="card">
    <h2>Messages</h2>
    <div class="statgrid">
      <div class="stat"><div class="v">${a.messages.total.toLocaleString()}</div><div class="k">total messages</div></div>
      <div class="stat"><div class="v">${a.messages.fromYou.toLocaleString()}</div><div class="k">from ${d.isGroup ? "the group" : "you"}</div></div>
      <div class="stat"><div class="v">${a.messages.fromEdmund.toLocaleString()}</div><div class="k">from Edmund</div></div>
      <div class="stat"><div class="v">${(a.messages.last7.fromYou + a.messages.last7.fromEdmund).toLocaleString()}</div><div class="k">last 7 days</div></div>
      <div class="stat"><div class="v">${(a.messages.last30.fromYou + a.messages.last30.fromEdmund).toLocaleString()}</div><div class="k">last 30 days</div></div>
      <div class="stat"><div class="v" style="font-size:1rem;padding-top:6px">${esc(fmtDay(a.messages.firstMs, d.tz))}</div><div class="k">talking since</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Proactive messages</h2>
    <p class="cap">Times Edmund reached out on his own, and how they landed.</p>
    <div class="statgrid">
      <div class="stat"><div class="v">${a.proactive.total}</div><div class="k">total sent</div></div>
      <div class="stat"><div class="v">${a.proactive.engaged}</div><div class="k">you replied</div></div>
      <div class="stat"><div class="v">${engageRate}</div><div class="k">reply rate</div></div>
      <div class="stat"><div class="v" style="font-size:1rem;padding-top:6px">${esc(fmtDay(a.proactive.lastFireMs, d.tz))}</div><div class="k">most recent</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Workspace</h2>
    <div class="statgrid">
      <div class="stat"><div class="v">${a.media.images}</div><div class="k">images</div></div>
      <div class="stat"><div class="v">${a.media.videos}</div><div class="k">videos</div></div>
      <div class="stat"><div class="v">${a.media.audio}</div><div class="k">voice memos</div></div>
      <div class="stat"><div class="v">${a.files.count}</div><div class="k">files (${fmtBytes(a.files.bytes)})</div></div>
      <div class="stat"><div class="v">${a.files.artifacts}</div><div class="k">artifacts</div></div>
      <div class="stat"><div class="v">${a.schedules.active}</div><div class="k">active schedules${a.schedules.paused ? ` (+${a.schedules.paused} paused)` : ""}</div></div>
    </div>
  </div>
</section>`;
}

// ─── tab: memory (DM only) ───────────────────────────────────────────

function memoryTab(d: PortalPageData): string {
  return `<section class="tab" id="tab-memory">
  <h1>Memory</h1>
  <p class="sub">Edmund keeps a private notes file about each person he talks to — preferences, context, things you've told him to remember. This is yours, in full. Read-only here: if something's wrong or you want it changed or forgotten, tell him in iMessage — or erase it entirely from the Privacy tab.</p>
  ${d.personBody ? `<article class="doc">${mdToHtml(d.personBody.slice(0, 40_000))}</article>` : `<div class="card"><div class="empty">No notes yet — he builds this up as you talk.</div></div>`}
</section>`;
}

/**
 * Minimal markdown → HTML for the person file: headings, bullet lists,
 * bold/italic/inline-code, paragraphs. Input is HTML-escaped FIRST, so the
 * file's content can never inject markup. Heading levels shift down one
 * (# → h2) to sit under the page's h1.
 */
function mdToHtml(src: string): string {
  const lines = esc(src).split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h?.[1] && h[2] !== undefined) {
      closeList();
      const lvl = Math.min(h[1].length + 1, 5);
      out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li?.[1] !== undefined) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${mdInline(li[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    if (/^[-_*]{3,}$/.test(line.trim())) {
      closeList();
      out.push("<hr>");
      continue;
    }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

function mdInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

// ─── tab: tips ───────────────────────────────────────────────────────

function tipsTab(d: PortalPageData): string {
  const tips: Array<[string, string]> = [
    [
      "Be specific about the result you want",
      "“Make me a one-page checklist PDF for closing the pool” beats “help with the pool”. Edmund can do real multi-step work — give him the finish line.",
    ],
    [
      "Send photos, screenshots, and voice memos",
      "He can read documents, identify things in pictures, listen to voice notes, and work from screenshots. Often faster than typing it out.",
    ],
    [
      "Put him on a schedule",
      "Text “every weekday at 7am send me the forecast and my day's reminders” — or build it on the Schedules tab. He does the work fresh each time it fires.",
    ],
    [
      "Ask for real artifacts",
      "Webpages, spreadsheets, PDFs, edited images, QR codes, research write-ups. Anything he makes shows up under Media, Files, and Artifacts here.",
    ],
    [
      "Teach him once, he remembers",
      "Corrections and preferences stick — “my daughter's name is June”, “never use emojis with me”. Check the Memory tab to see what he's kept.",
    ],
    [
      "Long jobs are fine",
      "“Research this and get back to me” works — he'll go off, do the work, and text you when it's done. You don't need to keep the conversation open.",
    ],
    [
      "Steer the proactive messages",
      "The note on the Proactive tab is read every time he considers reaching out. Tell him exactly what's welcome and what isn't.",
    ],
    [
      "Lost this page?",
      "Just text Edmund “send me my portal link” and he'll send a fresh one. The link is private to this chat — don't forward it.",
    ],
  ];
  if (d.isGroup) {
    tips.splice(4, 1, [
      "Address him by name in the group",
      "In group chats, mention Edmund when you want him — he stays out of conversations that aren't for him.",
    ]);
  }
  return `<section class="tab" id="tab-tips">
  <h1>Tips & Help</h1>
  <p class="sub">How to get the best results out of Edmund.</p>
  <div class="card">
    ${tips.map(([b, s]) => `<div class="tipline"><div><b>${esc(b)}</b><span>${esc(s)}</span></div></div>`).join("")}
  </div>
  <div class="card">
    <h2>About this page</h2>
    <p class="hint">Each tab explains itself at the top. Everything here is scoped to this one conversation — settings, files, and stats from other chats are never shown. The URL is your key: anyone holding the exact link can view and change this chat's settings, so treat it like a password.</p>
  </div>
</section>`;
}

// ─── tab: privacy ────────────────────────────────────────────────────

function privacyTab(d: PortalPageData): string {
  return `<section class="tab" id="tab-privacy">
  <h1>Privacy & Data</h1>
  <p class="sub">What Edmund keeps for this conversation, and how to delete it. Every action below is immediate and permanent.</p>

  <div class="card">
    <h2>What's stored</h2>
    <p class="hint">For this chat, Edmund keeps: a private <b>workspace</b> of files and media he made or received, ${d.isGroup ? "" : "a <b>notes file</b> about you (Memory tab), "}a <b>searchable index</b> of the conversation so he can recall past context, your <b>settings</b> from this page, your <b>schedules</b>, and a log of his <b>proactive messages</b>. The iMessage thread itself lives on your phone and Apple's servers — deleting data here doesn't touch your Messages app.</p>
  </div>

  <div class="card">
    <h2>Wipe media</h2>
    <p class="cap">Deletes every image, video, voice memo, and received attachment in this chat's workspace.</p>
    <button class="danger" data-priv="wipe-media">Delete all media</button>
  </div>

  <div class="card">
    <h2>Delete files & artifacts</h2>
    <p class="cap">Deletes the documents, notes, and working files in this chat's workspace. Media stays unless you wipe it too.</p>
    <button class="danger" data-priv="wipe-files">Delete files &amp; artifacts</button>
  </div>

  <div class="card">
    <h2>Reset the conversation</h2>
    <p class="cap">Edmund starts the next exchange with a blank slate — the running thread context is dropped. ${d.isGroup ? "" : "His notes about you survive a reset; use Erase everything to remove those too."}</p>
    <button class="danger" data-priv="reset-convo">Reset conversation memory</button>
  </div>

  <div class="card">
    <h2>Erase everything</h2>
    <p class="cap">The full wipe for this chat: workspace, media, ${d.isGroup ? "" : "his notes about you, "}search index, proactive-message history, your schedules, and the running conversation. Your settings on this page (and this link) survive. This cannot be undone.</p>
    <button class="danger" data-priv="erase-all" data-confirm="ERASE">Erase everything…</button>
  </div>
</section>`;
}

// ─── client script ───────────────────────────────────────────────────

function script(d: PortalPageData): string {
  return `<script>
const BASE = ${JSON.stringify(d.basePath)};
const $ = (s, r) => (r||document).querySelector(s);
const $$ = (s, r) => Array.from((r||document).querySelectorAll(s));
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2200);}
async function post(path, body){
  try{
    const res = await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const j = await res.json().catch(()=>({}));
    return res.ok ? (j||{ok:true}) : {error:j.error||'request failed'};
  }catch(e){return {error:'network error'};}
}

// ── tabs ──
function showTab(id){
  if(!document.getElementById('tab-'+id)) id='home';
  $$('.tab').forEach(t=>t.classList.toggle('active', t.id==='tab-'+id));
  $$('[data-tab]').forEach(a=>a.classList.toggle('active', a.dataset.tab===id));
  document.body.classList.remove('menu-open');
  window.scrollTo(0,0);
}
window.addEventListener('hashchange',()=>showTab(location.hash.slice(1)||'home'));
showTab(location.hash.slice(1)||'home');
$('#menu-btn').addEventListener('click',()=>document.body.classList.toggle('menu-open'));
$('#scrim').addEventListener('click',()=>document.body.classList.remove('menu-open'));

// ── settings ──
$$('.day .day-on').forEach(cb=>{
  cb.addEventListener('change',()=>{
    const day=cb.closest('.day');
    day.querySelector('.day-start').classList.toggle('muted',!cb.checked);
    day.querySelector('.day-end').classList.toggle('muted',!cb.checked);
  });
});
$('#save').addEventListener('click', async ()=>{
  const activeHours=[];
  $$('.day').forEach(day=>{
    if(!day.querySelector('.day-on').checked) return;
    activeHours.push({dow:day.dataset.dow,start:day.querySelector('.day-start').value||'09:00',end:day.querySelector('.day-end').value||'21:00'});
  });
  const r=await post('/settings',{enabled:$('#bn-on').checked,activeHours,note:$('#bn-note').value});
  toast(r.error?('Could not save: '+r.error):'Saved');
});

// ── search + chip filtering ──
function wireFilter(qSel, listSel, noneSel){
  const q=$(qSel); if(!q) return;
  q.addEventListener('input',()=>{
    const needle=q.value.trim().toLowerCase();
    let shown=0;
    $$(listSel+' [data-q]').forEach(el=>{const hit=!needle||el.dataset.q.includes(needle);el.style.display=hit?'':'none';if(hit)shown++;});
    const none=$(noneSel); if(none) none.style.display=shown?'none':'';
  });
}
wireFilter('#files-q','#files-list','#files-none');
wireFilter('#skills-q','#skills-list','#skills-none');
wireFilter('#arts-q','#arts-list','#arts-none');
let mediaFilter='all';
function applyMedia(){
  const needle=($('#media-q')?.value||'').trim().toLowerCase();
  let shown=0;
  $$('#media-grid [data-q]').forEach(el=>{
    let ok=!needle||el.dataset.q.includes(needle);
    if(ok&&mediaFilter!=='all'){
      ok = mediaFilter.startsWith('dir:') ? el.dataset.dir===mediaFilter.slice(4) : el.dataset.kind===mediaFilter;
    }
    el.style.display=ok?'':'none'; if(ok)shown++;
  });
  const none=$('#media-none'); if(none) none.style.display=shown?'none':'';
}
$('#media-q')?.addEventListener('input',applyMedia);
$$('#media-chips .chip').forEach(ch=>ch.addEventListener('click',()=>{
  $$('#media-chips .chip').forEach(c=>c.classList.remove('active'));
  ch.classList.add('active'); mediaFilter=ch.dataset.f; applyMedia();
}));

// ── schedules ──
const freqSel=$('#sch-freq');
function schWhen(){
  const f=freqSel.value;
  $('#sch-when-once').style.display = f==='once'?'':'none';
  $('#sch-when-dow').style.display  = f==='weekly'?'':'none';
  $('#sch-when-time').style.display = (f==='daily'||f==='weekly')?'':'none';
}
if(freqSel){freqSel.addEventListener('change',schWhen);schWhen();}
$('#sch-create')?.addEventListener('click', async ()=>{
  const prompt=$('#sch-prompt').value.trim();
  if(!prompt){toast('Describe what Edmund should do');return;}
  const freq=freqSel.value;
  const body={prompt,freq,time:$('#sch-time').value||'09:00',dow:$('#sch-dow').value};
  if(freq==='once'){
    const v=$('#sch-at').value;
    if(!v){toast('Pick a date and time');return;}
    body.atMs=new Date(v).getTime();
    if(!(body.atMs>Date.now())){toast('Pick a time in the future');return;}
  }
  const r=await post('/cron/create',body);
  if(r.error){toast(r.error);return;}
  toast('Scheduled'); setTimeout(()=>location.reload(),800);
});
$$('button[data-job]').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const act=btn.dataset.act;
    if(act==='cancel'&&!confirm('Delete this schedule for good?'))return;
    const r=await post('/cron/'+encodeURIComponent(btn.dataset.job)+'/'+act);
    if(r.error){toast(r.error);return;}
    toast(act==='pause'?'Paused':act==='resume'?'Resumed':'Deleted');
    setTimeout(()=>location.reload(),700);
  });
});

// ── privacy ──
const PRIV_MSGS={'wipe-media':'Delete ALL media in this chat\\u2019s workspace? This cannot be undone.','wipe-files':'Delete ALL files and artifacts in this chat\\u2019s workspace? This cannot be undone.','reset-convo':'Reset the running conversation? Edmund starts fresh on the next message.'};
$$('button[data-priv]').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const action=btn.dataset.priv;
    let confirmValue=true;
    if(btn.dataset.confirm){
      const typed=prompt('This permanently erases everything Edmund has for this chat.\\n\\nType '+btn.dataset.confirm+' to confirm:');
      if(typed!==btn.dataset.confirm){if(typed!==null)toast('Not confirmed — nothing was deleted');return;}
      confirmValue=typed;
    } else if(!confirm(PRIV_MSGS[action]||'Are you sure?')) return;
    btn.disabled=true; btn.textContent='Working…';
    const r=await post('/privacy/'+action,{confirm:confirmValue});
    btn.disabled=false;
    if(r.error){btn.textContent='Failed — try again';toast(r.error);return;}
    toast(r.summary||'Done');
    setTimeout(()=>location.reload(),1400);
  });
});

// ── credits ──
async function topUp(amountUsd){
  const r=await post('/credits/checkout',{amountUsd});
  if(r.error){toast(r.error);return;}
  if(r.url){location.href=r.url;}
}
$$('button[data-topup]').forEach(btn=>btn.addEventListener('click',()=>{btn.disabled=true;btn.textContent='Opening…';topUp(Number(btn.dataset.topup));}));
$('#topup-go')?.addEventListener('click',()=>{
  const v=Number($('#topup-custom').value);
  if(!(v>0)){toast('Enter an amount');return;}
  topUp(v);
});
if(new URLSearchParams(location.search).get('paid')==='1'){
  history.replaceState(null,'',location.pathname+location.hash);
  toast('Payment received — credit lands within a minute');
}
</script>`;
}
