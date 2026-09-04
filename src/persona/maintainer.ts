import { basename } from "node:path";
import { groupFilePath, personFilePath } from "../claude/persona.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { getRecentMessages } from "../imessage/history.ts";
import { getChatDisplayName } from "../imessage/participants.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { recordSpend } from "../spend/ledger.ts";
import { easternDateTime } from "../util/clock.ts";
import { log } from "../util/log.ts";
import { archiveGroupFile, archivePersonFile, personArchivableSections } from "./archive.ts";
import {
  GROUP_CONSOLIDATION_PROMPT,
  consolidatePerson,
  shouldConsolidate,
} from "./consolidate.ts";
import { readPersonFile, writePersonFile } from "./crud.ts";
import { type GroupSection, appendGroupNote, readGroupFile, writeGroupFile } from "./groups.ts";
import { type PersonSection, appendPersonNote } from "./write-note.ts";

/**
 * Background pass that keeps `persona/people/<handle>.md` (for DMs) and
 * `persona/groups/<slug>.md` (for groups) current. Triggered post-reply
 * from `PersonMaintainer.onMainReplied`; runs independently of the brown-
 * nose ghost so the operator can disable proactive outreach without
 * losing memory hygiene.
 *
 * Flow:
 *   1. Resolve subject (handle for DMs, chatGuid for groups).
 *   2. Load current file body (scaffold if absent).
 *   3. Pull last N messages from chat.db.
 *   4. Ask Haiku what should be added — JSON output, conservative rubric.
 *   5. Apply: either append per-section notes (cheap path, idempotent) or
 *      do a full rewrite (rare, only when the model thinks the file is
 *      stale enough to need restructuring).
 *
 * Failures are swallowed and logged — maintenance is enrichment, never
 * on a critical path.
 */

const MAINTAINER_TIMEOUT_MS = 90_000;

const DM_SECTIONS: PersonSection[] = [
  "who-they-are",
  "our-dynamic",
  "what-ive-learned",
  "shared-history",
  "open-items",
];

const GROUP_SECTIONS: GroupSection[] = [
  "whos-in-it",
  "group-dynamic",
  "recurring-topics",
  "open-items",
  "shared-history",
];

const DM_SECTION_RUBRIC = [
  "Sections you can append to (use these exact slugs in the JSON `section` field):",
  "  • who-they-are     — durable background, role, what they care about. Add only when a stable trait emerged.",
  "  • our-dynamic      — how this person talks to you, your posture with them. Add when a tone pattern is clear.",
  "  • what-ive-learned — recurring preferences, quirks, repeated topics. The most common bucket.",
  "  • shared-history   — dated events worth remembering (a milestone, a launch, a trip they went on). One bullet per event.",
  "  • open-items       — promises, follow-ups, anything in flight. Add when made; remove via full_rewrite when resolved.",
].join("\n");

const GROUP_SECTION_RUBRIC = [
  "Sections you can append to (use these exact slugs in the JSON `section` field):",
  "  • whos-in-it       — who's in the room, their relationship to each other. Add when a new participant established themselves.",
  "  • group-dynamic    — the vibe, in-jokes, recurring shorthand, who tends to drive the chat. Add when a pattern is clear.",
  "  • recurring-topics — themes the group keeps revisiting. Add only when a topic is genuinely recurring, not one-off.",
  "  • open-items       — shared plans, group-level follow-ups, decisions pending.",
  "  • shared-history   — dated group events worth remembering.",
].join("\n");

const SYSTEM_PROMPT_COMMON = `You are a background memory maintainer. After each conversation,
you review the recent exchange against the current persona file and decide
what (if anything) is worth adding. You are NOT writing replies to the user;
the main model already handled that. Your only job is to keep the persona
file current and accurate.

Output ONE valid JSON object — nothing else, no prose, no markdown fences.
Schema:
{
  "notes": [{ "section": "<slug>", "note": "<short prose>" }, ...],
  "full_rewrite": null | "<full new markdown body>",
  "reason": "<one-line explanation, for the maintainer log>"
}

Conservatism is the default:
- If the exchange added nothing durable, return {"notes": [], "full_rewrite": null, "reason": "nothing new worth noting"}. That is the correct output most of the time.
- A note must be DURABLE — true after this conversation ends. "They love sourdough" is durable; "they're hungry right now" is not.
- A note must be GROUNDED — visible in the recent exchange. Do not invent or infer from absence.
- A note must be NEW — read the current file carefully. If the same fact (or a near-paraphrase) is already there, do not re-add. The append path is de-duped by exact text but you should also catch semantic dupes.
- Each note ≤ 140 chars, plain prose, no bullets/headers/markdown.
- PRIVACY: never write secrets, confidences, medical details, financial details, anything embarrassing if it surfaced in another conversation. When in doubt, skip.

Use full_rewrite ONLY when the file is genuinely stale (duplicated bullets,
contradictions, obsolete open-items that resolved long ago). It backs up the
prior version so it's recoverable, but it's the heavy path — prefer notes[].`;

export type MaintenanceDeps = {
  config: Config;
  state: StateStore;
  chatDb: ChatDb;
  contacts: ContactBook;
};

export type MaintenanceResult =
  | { ok: true; subject: string; appliedNotes: number; rewrote: boolean; reason: string }
  | { ok: false; reason: string };

export async function runMaintenance(
  sessionKey: SessionKey,
  deps: MaintenanceDeps,
): Promise<MaintenanceResult> {
  const cfg = deps.config.people_maintainer;
  if (!cfg.enabled) return { ok: false, reason: "disabled" };

  const session = deps.state.getSession(sessionKey);
  if (!session) return { ok: false, reason: "no session row" };

  const lastMaintainedMs = deps.state.getLastMaintainedAtMs(sessionKey);
  if (session.lastInboundMs <= lastMaintainedMs) {
    return { ok: false, reason: "no new messages since last run" };
  }

  // Pull recent history. Cap by config; chat.db is the source of truth so
  // the model sees what actually happened (not what the harness chose to
  // forward).
  const chatGuid = session.chatGuid;
  const beforeRowId = currentHighWaterRowId(deps.chatDb);
  const history = getRecentMessages(deps.chatDb, chatGuid, beforeRowId + 1, cfg.recent_messages);
  if (history.length === 0) {
    return { ok: false, reason: "no chat.db messages" };
  }

  const isGroup = isGroupSession(sessionKey);
  if (isGroup) {
    return runGroupMaintenance({ sessionKey, chatGuid, history, deps, cfg });
  }
  return runDmMaintenance({ sessionKey, chatGuid, history, deps, cfg });
}

async function runDmMaintenance(args: {
  sessionKey: SessionKey;
  chatGuid: string;
  history: ReturnType<typeof getRecentMessages>;
  deps: MaintenanceDeps;
  cfg: Config["people_maintainer"];
}): Promise<MaintenanceResult> {
  const { sessionKey, history, deps, cfg } = args;
  const handle = chatIdFromKey(sessionKey);
  const displayName = deps.contacts.displayName(handle);
  const current = readPersonFile(handle);
  const currentBody = current?.body ?? "(no file yet — will be scaffolded on first write)";

  const prompt = buildPrompt({
    mode: "dm",
    subject: displayName ?? handle,
    currentBody,
    history,
    deps,
  });

  const raw = await spawnMaintainerModel(cfg.model, SYSTEM_PROMPT_COMMON, prompt, {
    dataDir: deps.config.paths.data_dir,
    sessionKey,
  });
  if (raw === null) return { ok: false, reason: "maintainer model call failed" };

  const parsed = parseOutput(raw, DM_SECTIONS);
  if (!parsed) return { ok: false, reason: "parse failed" };

  deps.state.setLastMaintainedAtMs(sessionKey, Date.now());

  if (cfg.dry_run) {
    log.info("maintainer", `dm:${shortHandle(handle)} → dry-run`, {
      proposed_notes: parsed.notes.length,
      rewrite: parsed.fullRewrite ? "yes" : "no",
      reason: parsed.reason,
    });
    return { ok: true, subject: handle, appliedNotes: 0, rewrote: false, reason: parsed.reason };
  }

  if (parsed.fullRewrite) {
    writePersonFile({ handle, displayName, body: parsed.fullRewrite });
    log.info("maintainer", `dm:${shortHandle(handle)} → full rewrite`, {
      chars: parsed.fullRewrite.length,
      reason: parsed.reason,
    });
    return {
      ok: true,
      subject: handle,
      appliedNotes: parsed.notes.length,
      rewrote: true,
      reason: parsed.reason,
    };
  }

  let applied = 0;
  for (const n of parsed.notes) {
    try {
      appendPersonNote({
        handle,
        displayName,
        section: n.section as PersonSection,
        note: n.note,
      });
      applied++;
    } catch (err) {
      log.warn("maintainer", "append failed", { handle, err: (err as Error).message });
    }
  }
  // CONSOLIDATE BEFORE ARCHIVING. The order matters and was wrong: archiving
  // moves the oldest observations out, so running it first hands the
  // consolidator a view the archiver has already thinned — it would derive the
  // rules for a person from a file with that person's history removed.
  //
  // Principles are also what makes the archiving below safe to widen. They
  // persist and are revised across passes, so knowledge earned from an
  // observation survives that observation leaving the live file, and the
  // evidence dates still resolve because the archive is recall-indexed.
  try {
    const before = readPersonFile(handle);
    if (before?.body && shouldConsolidate(before.body)) {
      await consolidatePerson(handle, (system, user) =>
        spawnMaintainerModel(cfg.model, system, user, {
          dataDir: deps.config.paths.data_dir,
          sessionKey,
        }),
      );
    }
  } catch (err) {
    // Never fail maintenance over consolidation; the log is still correct.
    log.warn("persona-consolidate", "pass failed", { err: (err as Error).message });
  }

  // Size gate, AFTER consolidation. Once the file has principles, "Our
  // Dynamic" joins the archivable sections — that section is the principles in
  // undistilled form ("he pings until answered", "his cut ships"), so keeping
  // both live pays twice for the same knowledge. It stays exempt until the
  // rules actually exist. `Who They Are` is never archived: identity, medical
  // history and methodology are not something a rule encodes.
  try {
    const body = readPersonFile(handle)?.body ?? "";
    archivePersonFile(
      basename(personFilePath(handle)),
      undefined,
      personArchivableSections(body),
    );
  } catch (err) {
    log.warn("maintainer", "archive sweep failed", { handle, err: (err as Error).message });
  }
  log.info("maintainer", `dm:${shortHandle(handle)} → +${applied} notes`, {
    reason: parsed.reason,
  });
  return {
    ok: true,
    subject: handle,
    appliedNotes: applied,
    rewrote: false,
    reason: parsed.reason,
  };
}

async function runGroupMaintenance(args: {
  sessionKey: SessionKey;
  chatGuid: string;
  history: ReturnType<typeof getRecentMessages>;
  deps: MaintenanceDeps;
  cfg: Config["people_maintainer"];
}): Promise<MaintenanceResult> {
  const { sessionKey, chatGuid, history, deps, cfg } = args;
  const displayName = getChatDisplayName(deps.chatDb, chatGuid);
  const current = readGroupFile(chatGuid);
  const currentBody = current?.body ?? "(no file yet — will be scaffolded on first write)";

  const prompt = buildPrompt({
    mode: "group",
    subject: displayName ?? chatGuid.slice(0, 12),
    currentBody,
    history,
    deps,
  });

  const raw = await spawnMaintainerModel(cfg.model, SYSTEM_PROMPT_COMMON, prompt, {
    dataDir: deps.config.paths.data_dir,
    sessionKey,
  });
  if (raw === null) return { ok: false, reason: "maintainer model call failed" };

  const parsed = parseOutput(raw, GROUP_SECTIONS);
  if (!parsed) return { ok: false, reason: "parse failed" };

  deps.state.setLastMaintainedAtMs(sessionKey, Date.now());

  if (cfg.dry_run) {
    log.info("maintainer", `group:${shortGuid(chatGuid)} → dry-run`, {
      proposed_notes: parsed.notes.length,
      rewrite: parsed.fullRewrite ? "yes" : "no",
      reason: parsed.reason,
    });
    return { ok: true, subject: chatGuid, appliedNotes: 0, rewrote: false, reason: parsed.reason };
  }

  if (parsed.fullRewrite) {
    writeGroupFile({ chatGuid, displayName, body: parsed.fullRewrite });
    log.info("maintainer", `group:${shortGuid(chatGuid)} → full rewrite`, {
      chars: parsed.fullRewrite.length,
      reason: parsed.reason,
    });
    return {
      ok: true,
      subject: chatGuid,
      appliedNotes: parsed.notes.length,
      rewrote: true,
      reason: parsed.reason,
    };
  }

  let applied = 0;
  for (const n of parsed.notes) {
    try {
      appendGroupNote({
        chatGuid,
        displayName,
        section: n.section as GroupSection,
        note: n.note,
      });
      applied++;
    } catch (err) {
      log.warn("maintainer", "append failed", { chatGuid, err: (err as Error).message });
    }
  }
  // Consolidate before archiving, same ordering and same reason as the DM
  // path: the archiver thins the file, so running it first would derive this
  // room's rules from a view with the room's history removed.
  //
  // The GROUP prompt is used, not the DM one. A group's register is contagious
  // and a pass that only asked "what works in this room" would read a bad
  // afternoon as evidence that the room trades insults and write that down as
  // doctrine — turning a drift into a personality. The group prompt separates
  // how the room works from how Edmund behaves in it, and asks him to correct
  // his own drift rather than ratify it.
  try {
    const before = readGroupFile(chatGuid);
    if (before?.body && shouldConsolidate(before.body)) {
      await consolidatePerson(
        chatGuid,
        (system, user) =>
          spawnMaintainerModel(cfg.model, system, user, {
            dataDir: deps.config.paths.data_dir,
            sessionKey,
          }),
        GROUP_CONSOLIDATION_PROMPT,
        groupFilePath,
        "group",
      );
    }
  } catch (err) {
    log.warn("persona-consolidate", "group pass failed", { err: (err as Error).message });
  }

  // Same size gate as person files: aged Group Dynamic / Shared History
  // bullets move to the append-only archive once the file is oversized.
  try {
    archiveGroupFile(basename(groupFilePath(chatGuid)));
  } catch (err) {
    log.warn("maintainer", "group archive sweep failed", {
      chatGuid,
      err: (err as Error).message,
    });
  }
  log.info("maintainer", `group:${shortGuid(chatGuid)} → +${applied} notes`, {
    reason: parsed.reason,
  });
  return {
    ok: true,
    subject: chatGuid,
    appliedNotes: applied,
    rewrote: false,
    reason: parsed.reason,
  };
}

function buildPrompt(args: {
  mode: "dm" | "group";
  subject: string;
  currentBody: string;
  history: ReturnType<typeof getRecentMessages>;
  deps: MaintenanceDeps;
}): string {
  const rubric = args.mode === "dm" ? DM_SECTION_RUBRIC : GROUP_SECTION_RUBRIC;
  const speakerTagged = args.history
    .map((m) => {
      const who = m.fromMe
        ? "Edmund"
        : (args.deps.contacts.displayName(m.fromHandle) ?? m.fromHandle ?? "?");
      const ts = easternDateTime(new Date(m.timestampMs));
      return `[${ts}] ${who}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`;
    })
    .join("\n");

  return [
    `Subject: ${args.subject} (${args.mode === "dm" ? "1-on-1 DM" : "group chat"})`,
    "",
    rubric,
    "",
    "=== Current persona file ===",
    args.currentBody,
    "",
    "=== Recent exchange (chronological, most recent last) ===",
    speakerTagged,
    "",
    "=== Your task ===",
    'Compare the recent exchange to the current file. Return the JSON object as specified in the system prompt. Default to {"notes": [], "full_rewrite": null, "reason": "..."} when nothing durable emerged.',
  ].join("\n");
}

function parseOutput(
  raw: string,
  validSections: string[],
): {
  notes: Array<{ section: string; note: string }>;
  fullRewrite: string | null;
  reason: string;
} | null {
  // Strip code fences if the model wrapped its JSON despite instructions.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    log.warn("maintainer", "JSON parse failed", { preview: stripped.slice(0, 200) });
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const notesRaw = Array.isArray(o.notes) ? o.notes : [];
  const notes: Array<{ section: string; note: string }> = [];
  for (const n of notesRaw) {
    if (!n || typeof n !== "object") continue;
    const nn = n as Record<string, unknown>;
    const section = typeof nn.section === "string" ? nn.section : "";
    const note = typeof nn.note === "string" ? nn.note.trim() : "";
    if (!section || !note) continue;
    if (!validSections.includes(section)) {
      log.debug?.("maintainer", "dropping note with invalid section", { section });
      continue;
    }
    notes.push({ section, note });
  }
  const fullRewrite =
    typeof o.full_rewrite === "string" && o.full_rewrite.trim().length > 0 ? o.full_rewrite : null;
  const reason = typeof o.reason === "string" ? o.reason : "";
  return { notes, fullRewrite, reason };
}

/** One maintainer model call, spend-accounted (subsystem "maintainer"). */
async function spawnMaintainerModel(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  spend: { dataDir: string; sessionKey: string },
): Promise<string | null> {
  const r = await runModelOneShot({
    args: [
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      systemPrompt,
    ],
    input: userPrompt,
    timeoutMs: MAINTAINER_TIMEOUT_MS,
  });
  recordSpend(spend.dataDir, {
    sessionKey: spend.sessionKey,
    subsystem: "maintainer",
    model: r.model ?? model,
    costUsd: r.costUsd,
    durMs: r.durationMs,
  });
  if (!r.ok) {
    log.warn("persona-maintainer", "model call failed", { err: r.error ?? "unknown" });
    return null;
  }
  return r.text;
}

function currentHighWaterRowId(chatDb: ChatDb): number {
  const row = chatDb.query<{ m: number | null }>("SELECT MAX(ROWID) AS m FROM message").get();
  return row?.m ?? 0;
}

function shortHandle(h: string): string {
  return h.length > 16 ? h.slice(0, 16) : h;
}

function shortGuid(g: string): string {
  return g.slice(0, 12);
}
