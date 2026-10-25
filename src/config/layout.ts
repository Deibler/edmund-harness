import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";

/**
 * The order config.toml is laid out in, and what each part is for.
 *
 * Sections are grouped by how often they are changed, measured on
 * 2026-10-25 from the dashboard's save backups, every agent edit of the file
 * on record, and the example's git history: model choices, proactive
 * intensity, group addressing, guest campaigns and the like change every
 * week or two; the delivery plumbing and cost controls at the bottom have not
 * been touched in months and are where a casual change does damage. The
 * formatter below writes a config in this order with these notes, the
 * dashboard saves through it, `edmund config tidy` applies it to an existing
 * file, and config.example.toml follows the same order (a test checks).
 */

export type LayoutSection = { name: string; note: string };
export type LayoutTier = { title: string; intro: string; sections: LayoutSection[] };

export const CONFIG_LAYOUT: LayoutTier[] = [
  {
    title: "The knobs that get turned",
    intro: "Models, how forward Edmund is, and who gets what. Change these freely.",
    sections: [
      {
        name: "claude",
        note: "The main model and how hard it thinks. agent_model runs subagents; background_effort runs memory upkeep.",
      },
      {
        name: "brown_nose",
        note: "Proactive messages (Edmund writing first): intensity 0-10, the models that decide, and daily caps.",
      },
      {
        name: "group_addressing",
        note: "When Edmund answers in a group without being named, and how many times a day it may.",
      },
      {
        name: "people_maintainer",
        note: "Memory upkeep after conversations. consolidation_model writes each chat's operating rules: judgment, so a strong model.",
      },
      { name: "guest_access", note: "Whether guest links work at all." },
      {
        name: "guest_campaigns",
        note: "Guest campaigns: who may talk to Edmund through a link, with what context, until when, and how much they may spend.",
      },
      {
        name: "computer_use",
        note: "The Mac apps Edmund may drive on screen, for you and for contacts, and the classifier that checks each action.",
      },
      {
        name: "imessage_actions",
        note: "What Edmund may do in Messages beyond sending: effects, edits, unsend, new chats, group changes.",
      },
      { name: "mcp_servers", note: "Extra tool servers, and which tiers of people get each one." },
    ],
  },
  {
    title: "Features and services",
    intro: "Turn things on and off, and point them at the right place.",
    sections: [
      {
        name: "integrations",
        note: "Optional packages under integrations/; integrations-config.yaml says which run here.",
      },
      {
        name: "printer",
        note: "The 3D printer. The access code is a LAN password: it stays in this file only.",
      },
      { name: "kitchen", note: "Household kitchen ledgers and their site." },
      {
        name: "shelf",
        note: "Permanent links for what Edmund hands people, served by the kitchen host.",
      },
      { name: "mirror", note: "The smart mirror: its own model, voice and connection." },
      { name: "sms", note: "The SMS line (Twilio)." },
      { name: "fishing", note: "The fishing data service." },
      { name: "radaromega", note: "The RadarOmega weather app Edmund drives." },
      {
        name: "trading",
        note: "Robinhood trading. Real money: leave disabled unless you mean it.",
      },
      {
        name: "orchestrators",
        note: "Extra named personas on other models. Empty means Edmund alone.",
      },
      { name: "dashboard", note: "The operator dashboard." },
      { name: "instant_share", note: "Quick share pages." },
      { name: "tools", note: "Image, speech and voice providers for the built-in tools." },
      {
        name: "openrouter",
        note: "Generation (images, video, audio): default models and price ceilings.",
      },
      { name: "credits", note: "Per-person generation credit, sold through Stripe." },
      { name: "cloudflare", note: "Cloudflare account for headless browsing and Pages." },
    ],
  },
  {
    title: "People and access",
    intro: "Set once. These decide who Edmund listens to, answers, and treats as the operator.",
    sections: [
      { name: "owner", note: "Your name, as Edmund refers to you." },
      {
        name: "self",
        note: "Edmund's own handles. Messages from these are its own and are ignored.",
      },
      { name: "identity", note: "The names Edmund answers to in a group." },
      {
        name: "contacts",
        note: "People with more than one handle, so they are one person to Edmund.",
      },
      { name: "alerts", note: "Where operator alerts go (auth failures, crashes)." },
      {
        name: "security",
        note: "Trust policy: what the model may touch on this Mac and what contacts get.",
      },
      {
        name: "allowlist",
        note: "Who may DM Edmund and which groups it joins (see [security] for open allowlists).",
      },
      {
        name: "outbound",
        note: "Whether Edmund may message people and groups other than the one it is talking to.",
      },
    ],
  },
  {
    title: "Secrets",
    intro:
      "API keys. They live only in this file; never paste them into config.example.toml or a message.",
    sections: [{ name: "keys", note: "Provider keys." }],
  },
  {
    title: "Leave alone unless we have talked it through",
    intro:
      "Plumbing and cost controls. Each value here was set against a measured problem; a casual change brings it back.",
    sections: [
      {
        name: "claude.auto_compact",
        note: "When long conversations are compacted. Raising the threshold multiplies the cost of every later turn (CLAUDE.md, Part 3).",
      },
      {
        name: "claude.pool",
        note: "Warm model workers: how many, and how long an idle one is kept.",
      },
      {
        name: "behavior",
        note: "Reply timing, debouncing and history. Tuned against double replies and slow answers.",
      },
      {
        name: "memory_recall",
        note: "How past messages are recalled into a turn. Tuned on measured recall quality.",
      },
      {
        name: "imessage_send",
        note: "Send health checks. Never relax the send guard: it stops messages reaching the wrong chat.",
      },
      { name: "imessage_watcher", note: "How new messages are noticed." },
      { name: "recovery", note: "The stuck-conversation healer and its fallback notice." },
      { name: "resources", note: "Memory limits that restart the daemon." },
      { name: "paths", note: "Where Messages' database and Edmund's data live." },
      { name: "codex", note: "Used only when [claude] model names a gpt-* model." },
      { name: "evals", note: "Reply-quality probes and the weekly review." },
      { name: "skill_curator", note: "Curating the skills Edmund writes for itself." },
      { name: "skills_marketplace", note: "Where installable skills may come from." },
      { name: "public_skills", note: "Consent for skills published to other people." },
      {
        name: "announcements",
        note: "When Edmund mentions a capability someone has not used yet.",
      },
      { name: "triggers", note: "Model-authored watch conditions (URL probes and the like)." },
    ],
  },
];

/** Every section the layout places, in file order. */
export function layoutOrder(): string[] {
  return CONFIG_LAYOUT.flatMap((t) => t.sections.map((s) => s.name));
}

export const HEADER = [
  "# edmund-harness configuration",
  "#",
  "# Laid out by how often each part is changed: the knobs that get turned at",
  "# the top, the plumbing to leave alone at the bottom. `edmund config tidy`",
  "# restores this layout and the dashboard's Settings page keeps it on save.",
  "# Comments inside a section are not kept by a dashboard save; put notes",
  "# about this machine in the block below this one.",
];
const NOTES_MARK = "# ── Notes for this machine ──";

type Obj = Record<string, unknown>;
const isTable = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const isTableArray = (v: unknown): v is Obj[] =>
  Array.isArray(v) && v.length > 0 && v.every(isTable);

function wrap(text: string, width = 78): string[] {
  const out: string[] = [];
  let line = "#";
  for (const word of text.split(/\s+/)) {
    if (line.length + 1 + word.length > width) {
      out.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  if (line !== "#") out.push(line);
  return out;
}

/** The ruled banner that opens a tier, shared by the formatter and config.example.toml. */
export function tierBanner(t: LayoutTier): string[] {
  const rule = `# ${"═".repeat(76)}`;
  return [rule, `# ${t.title.toUpperCase()}`, ...wrap(t.intro), rule];
}

/** The value at a dotted section path, and the object with that path's own sub-sections removed. */
function pick(obj: Obj, path: string, placed: Set<string>): unknown {
  let v: unknown = obj;
  for (const part of path.split(".")) v = isTable(v) ? v[part] : undefined;
  if (!isTable(v)) return v;
  // Sub-sections the layout places elsewhere are left for their own spot.
  const own: Obj = {};
  for (const [k, sub] of Object.entries(v)) if (!placed.has(`${path}.${k}`)) own[k] = sub;
  return own;
}

function nest(path: string, value: unknown): Obj {
  const parts = path.split(".");
  let out: Obj = { [parts.at(-1)!]: value };
  for (const p of parts.slice(0, -1).reverse()) out = { [p]: out };
  return out;
}

/** The leading comment block of an existing file, minus the generated header. */
export function machineNotes(raw: string): string[] {
  const lead: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) lead.push(line);
    else break;
  }
  const mark = lead.indexOf(NOTES_MARK);
  const notes = mark >= 0 ? lead.slice(mark + 1) : lead[0]?.startsWith(HEADER[0]!) ? [] : lead;
  // A section's own note sits just above its header; leave it to the formatter.
  while (notes.length && (notes.at(-1)!.trim() === "" || /^#\s*[═]/.test(notes.at(-1)!)))
    notes.pop();
  return notes.filter((l, i, a) => !(l.trim() === "" && a[i - 1]?.trim() === ""));
}

/**
 * Write a parsed config in layout order, with tier banners and a note above
 * each section. Values are untouched: parsing the output gives back the
 * input exactly (the dashboard and `config tidy` both check this before
 * writing). Sections the layout does not name are kept, at the end.
 */
export function formatConfig(obj: Obj, notes: string[] = []): string {
  const out: string[] = [...HEADER];
  if (notes.length) out.push("", NOTES_MARK, ...notes);
  const placed = new Set(layoutOrder());

  // Plain values at the top level must come before the first [table].
  const rootPlain: Obj = {};
  for (const [k, v] of Object.entries(obj)) if (!isTable(v) && !isTableArray(v)) rootPlain[k] = v;
  if (Object.keys(rootPlain).length) out.push("", stringify(rootPlain).trim());

  const emit = (name: string, note: string) => {
    const v = pick(obj, name, placed);
    if (v === undefined || name in rootPlain) return false;
    if (isTable(v) && Object.keys(v).length === 0 && name.includes(".")) return false;
    const body = stringify(nest(name, v)).trim();
    if (!body) return false;
    out.push("", ...wrap(note), body);
    return true;
  };

  for (const tier of CONFIG_LAYOUT) {
    const start = out.length;
    out.push("", "", ...tierBanner(tier));
    let any = false;
    for (const s of tier.sections) any = emit(s.name, s.note) || any;
    if (!any) out.length = start;
  }

  const others = Object.keys(obj).filter(
    (k) => !placed.has(k) && !(k in rootPlain) && ![...placed].some((p) => p.startsWith(`${k}.`)),
  );
  if (others.length) {
    out.push(
      "",
      "",
      ...tierBanner({
        title: "Other",
        intro: "Sections the layout does not name yet.",
        sections: [],
      }),
    );
    for (const k of others) out.push("", stringify({ [k]: obj[k] }).trim());
  }
  return `${out.join("\n")}\n`;
}

/**
 * Lay a config out and prove the layout only moved things: the text is
 * parsed back and must equal the input value for value, or nothing is
 * returned to write. The dashboard's save and `edmund config tidy` both go
 * through here; `format` is a parameter so the refusal can be tested.
 */
export function formatChecked(
  obj: Obj,
  notes: string[] = [],
  format: (o: Obj, n: string[]) => string = formatConfig,
): string {
  const text = format(obj, notes);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  if (!isDeepStrictEqual(plain(parse(text)), plain(obj))) {
    throw new Error("laying out config.toml would change a value; nothing written");
  }
  return text;
}
