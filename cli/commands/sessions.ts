/**
 * `edmund sessions list`             — every session, newest first.
 * `edmund sessions reset    <key>`   — clear the provider thread id (force cold start).
 * `edmund sessions compact  <key>`   — compact a Claude session JSONL down to TARGET_AFTER_COMPACT.
 * `edmund sessions heal     <key>`   — run the healer registered for the last recorded error class.
 * `edmund sessions invoke   <key>`   — heal + run the recovery-context turn (model decides what to say).
 * `edmund sessions rerun    <key>`   — invoke against the most recent unanswered inbound (ignores cooldown).
 * `edmund sessions wipe     <key>`   — delete the session row, replayed-rowId entries, and the JSONL file.
 *
 * For invoke/rerun, the model talks to the user — use sparingly.
 */

import { existsSync, unlinkSync } from "node:fs";
import {
  TARGET_AFTER_COMPACT,
  compactSession,
  sessionFilePath,
} from "../../src/claude/session-compact.ts";
import { loadConfig } from "../../src/config/config.ts";
import { CronStore } from "../../src/cron/store.ts";
import { resolveIntensity } from "../../src/ghost/intensity.ts";
import {
  type BrownNosePrefs,
  type FireRecord,
  GhostPrefsStore,
  snoozeActive,
} from "../../src/ghost/prefs.ts";
import { readRecentDecisions, runGhostTick } from "../../src/ghost/think.ts";
import { ChatDb } from "../../src/imessage/db.ts";
import { getChatDisplayName, getGroupParticipants } from "../../src/imessage/participants.ts";
import { ensureSandbox, sandboxDir } from "../../src/persona/sandbox.ts";
import { enqueueBrownNoseFire } from "../../src/proactive/queue.ts";
import { type FailureClass, classifyError } from "../../src/recovery/classify.ts";
import { HEALERS } from "../../src/recovery/healers.ts";
import { loadUnansweredInbound, runRecoveryTurn } from "../../src/recovery/turn.ts";
import { AddressBook } from "../../src/sessions/address-book.ts";
import { ContactBook } from "../../src/sessions/contacts.ts";
import { EchoCache } from "../../src/sessions/echo-cache.ts";
import { type SessionKey, chatIdFromKey, isGroupSession } from "../../src/sessions/key.ts";
import { SessionLocks } from "../../src/sessions/locks.ts";
import { type SessionRecord, StateStore } from "../../src/sessions/store.ts";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import { badge, color, fail, info, kv, ok, print, section, table } from "../ui.ts";

function rel(ms: number): string {
  if (!ms) return color.dim("—");
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

const USAGE = [
  "usage: edmund sessions <subcommand>",
  "",
  "  list                                          — every session, newest first",
  "  reset <key>                                   — clear provider thread id (force cold)",
  "  compact <key>                                 — compact Claude session JSONL",
  "  heal <key>                                    — run healer for last error class",
  "  invoke <key>                                  — heal + recovery-context turn",
  "  rerun <key>                                   — invoke ignoring cooldown",
  "  wipe <key>                                    — drop session row + JSONL",
  "  pending                                       — show orphaned inbound ack rows",
  "",
  "  brownnose list                                — every session's brown-nose state",
  "  brownnose show <key>                          — full snapshot",
  "  brownnose enable <key>                        — turn brown-nose on",
  "  brownnose disable <key> [--reason …]          — turn off + record reason",
  "  brownnose reset <key>                         — drop brown-nose prefs row",
  "  brownnose invoke <key> [--force|--fire-now|--dry-run]",
  "                                                — manual ghost tick",
].join("\n");

export async function sessionsCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0] ?? "list";
  const cfg = loadConfig();
  const state = new StateStore(cfg.paths.data_dir);
  const contacts = new ContactBook(cfg.contacts, new AddressBook());
  try {
    switch (sub) {
      case "list":
      case "ls":
        await listSessions(state, contacts);
        return;
      case "reset":
        await resetSession(state, requireKey(p));
        return;
      case "compact":
        await compactSubcmd(state, requireKey(p));
        return;
      case "heal":
        await healSubcmd(state, requireKey(p));
        return;
      case "invoke":
        await invokeSubcmd(cfg, state, requireKey(p), { forceIgnoreCooldown: false });
        return;
      case "rerun":
        await invokeSubcmd(cfg, state, requireKey(p), { forceIgnoreCooldown: true });
        return;
      case "wipe":
        await wipeSubcmd(state, requireKey(p));
        return;
      case "pending":
        await showPending(state, contacts);
        return;
      case "brownnose":
      case "bn":
        await runBrownNose(p, cfg, state, contacts);
        return;
      default:
        fail(`unknown sessions subcommand: ${sub}`);
        info(USAGE);
        process.exit(2);
    }
  } finally {
    state.close();
  }
}

function requireKey(p: Parsed): string {
  const key = p.positional[1];
  if (!key) {
    fail("missing session key");
    info(USAGE);
    process.exit(2);
  }
  return key;
}

async function listSessions(state: StateStore, contacts: ContactBook): Promise<void> {
  const rows = state.listSessions();
  section("sessions");
  if (rows.length === 0) {
    info("none yet.");
    return;
  }
  const data = rows.map((s) => {
    const id = chatIdFromKey(s.sessionKey);
    const label = isGroupSession(s.sessionKey)
      ? `group ${id.slice(0, 12)}…`
      : (contacts.displayName(id) ?? id);
    const errCell = s.lastErrorClass
      ? color.red(`${s.lastErrorClass}×${s.healAttemptsCount}`)
      : color.dim("—");
    return [
      label,
      isGroupSession(s.sessionKey) ? badge("group", "info") : badge("dm", "muted"),
      rel(s.lastInboundMs),
      rel(s.lastOutboundMs),
      s.claudeSessionId
        ? color.dim(`${s.sessionBackend ?? "claude"}:${s.claudeSessionId.slice(0, 8)}`)
        : color.red(`(${s.sessionBackend ?? "unbound"}:cold)`),
      errCell,
      color.dim(s.sessionKey),
    ];
  });
  table(["who", "kind", "last in", "last out", "provider:thread", "last err", "key"], data);
  print("");
  info(`${rows.length} session(s)`);
}

async function resetSession(state: StateStore, key: string): Promise<void> {
  if (!state.getSession(key)) {
    fail("no such session");
    process.exit(1);
  }
  state.setClaudeSessionId(key, null);
  ok(`cleared provider thread for ${key} — next turn will cold-start.`);
}

async function compactSubcmd(state: StateStore, key: string): Promise<void> {
  const sess = state.getSession(key);
  if (!sess) {
    fail("no such session");
    process.exit(1);
  }
  if (!sess.claudeSessionId) {
    fail("session has no provider thread id (never ran or already reset)");
    process.exit(1);
  }
  if (sess.sessionBackend === "codex") {
    info("Codex owns compaction for this thread; the manual JSONL compactor is Claude-only.");
    return;
  }
  const sandboxPath = ensureSandbox(key, null);
  const path = sessionFilePath(sandboxPath, sess.claudeSessionId);
  if (!existsSync(path)) {
    fail(`session file not found at ${path}`);
    process.exit(1);
  }
  const result = compactSession(path, TARGET_AFTER_COMPACT);
  if (!result.changed) {
    info(
      `no compaction needed (${(result.beforeBytes / 1_000_000).toFixed(2)} MB, target ${(TARGET_AFTER_COMPACT / 1_000_000).toFixed(0)} MB).`,
    );
    return;
  }
  ok(
    `compacted: ${(result.beforeBytes / 1_000_000).toFixed(2)} MB → ${(result.afterBytes / 1_000_000).toFixed(2)} MB (${result.imagesCompacted}/${result.totalImages} images elided)`,
  );
}

async function healSubcmd(state: StateStore, key: string): Promise<void> {
  const sess = state.getSession(key);
  if (!sess) {
    fail("no such session");
    process.exit(1);
  }
  const cls = (sess.lastErrorClass ?? "unknown") as FailureClass;
  const healer = healerForSession(sess, cls);
  if (!healer) {
    info(`no healer registered for class "${cls}". Nothing to heal.`);
    return;
  }
  const sandboxPath = ensureSandbox(key, null);
  const result = await healer(key, { state, sandboxPath });
  if (!result.ok) {
    fail(`heal failed: ${result.detail ?? "(no detail)"}`);
    process.exit(1);
  }
  if (!result.changed) {
    info(`heal ran (class=${cls}) but didn't need to change anything. ${result.detail ?? ""}`);
    return;
  }
  ok(`healed (class=${cls}): ${result.detail ?? ""}`);
}

async function invokeSubcmd(
  cfg: ReturnType<typeof loadConfig>,
  state: StateStore,
  key: string,
  opts: { forceIgnoreCooldown: boolean },
): Promise<void> {
  const sess = state.getSession(key);
  if (!sess) {
    fail("no such session");
    process.exit(1);
  }
  if (!opts.forceIgnoreCooldown && sess.lastRecoveryAttemptMs > 0) {
    const cooldown = cfg.recovery.cooldown_minutes * 60_000;
    const since = Date.now() - sess.lastRecoveryAttemptMs;
    if (since < cooldown) {
      const remaining = Math.round((cooldown - since) / 1000);
      fail(`recovery cooldown active (${remaining}s remaining). Use \`rerun\` to force.`);
      process.exit(1);
    }
  }
  const chatDb = new ChatDb(cfg.paths.chat_db);
  const echoes = new EchoCache();
  const locks = new SessionLocks();
  try {
    const cls = (sess.lastErrorClass ?? "unknown") as FailureClass;
    const healer = healerForSession(sess, cls);
    let healed = false;
    if (healer) {
      const sandboxPath = ensureSandbox(key, null);
      const r = await healer(key, { state, sandboxPath });
      healed = r.changed;
      if (!r.ok) {
        fail(`heal failed before invoke: ${r.detail ?? "(no detail)"}`);
        process.exit(1);
      }
      if (r.changed) info(`pre-invoke heal (class=${cls}): ${r.detail ?? ""}`);
    }
    const unanswered = loadUnansweredInbound(chatDb, sess.chatGuid, sess.lastOutboundMs);
    if (unanswered.length === 0) {
      info("no unanswered inbound for this session — nothing to invoke against.");
      return;
    }
    info(`invoking on ${unanswered.length} unanswered message(s)…`);
    const result = await runRecoveryTurn(
      key,
      {
        errorClass: cls,
        healed,
        rawError: null,
        unanswered,
        nowMs: Date.now(),
      },
      { config: cfg, state, chatDb, echoes, locks },
    );
    if (!result.ok) {
      fail(`invoke failed: ${classifyError(result.error)} — ${result.error}`);
      process.exit(1);
    }
    if (result.silenced) {
      ok("model produced a silence-intent reply (no message sent).");
    } else {
      ok(`reply delivered (${result.sent} chunk(s)).`);
    }
  } finally {
    chatDb.close();
  }
}

async function wipeSubcmd(state: StateStore, key: string): Promise<void> {
  const sess = state.getSession(key);
  if (!sess) {
    fail("no such session");
    process.exit(1);
  }
  // Delete the on-disk JSONL too (Claude Code's transcript). The session
  // record is the daemon's pointer; without it the file is orphaned.
  if (sess.claudeSessionId && sess.sessionBackend !== "codex") {
    const sandboxPath = ensureSandbox(key, null);
    const path = sessionFilePath(sandboxPath, sess.claudeSessionId);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        info(`removed ${path}`);
      } catch (err) {
        fail(`could not delete session jsonl: ${(err as Error).message}`);
        // proceed anyway — the state row is what matters for routing
      }
    }
  }
  state.deleteSession(key);
  ok(`wiped session ${key}`);
}

function healerForSession(session: SessionRecord, cls: FailureClass) {
  if (
    session.sessionBackend === "codex" &&
    (cls === "request_too_large" || cls === "image_dim_exceeded" || cls === "bad_tool_ids")
  ) {
    return null;
  }
  return HEALERS[cls];
}

// ----------------------------------------------------------------------
// `edmund sessions brownnose …`
// ----------------------------------------------------------------------
//
// Brown-nose is one aspect of a session (alongside reset/heal/wipe/etc.),
// so it lives under `sessions` rather than as a separate top-level noun.
// All subcommands follow the same `<verb> <key>` shape used elsewhere in
// this file.

const BN_USAGE =
  'usage: edmund sessions brownnose [list | show <key> | enable <key> | disable <key> [--reason …] | reset <key> | invoke <key> [--force|--fire-now|--dry-run|--brief "…"]]';

async function runBrownNose(
  p: Parsed,
  cfg: ReturnType<typeof loadConfig>,
  state: StateStore,
  contacts: ContactBook,
): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const prefs = new GhostPrefsStore(cfg.paths.data_dir);
  const chatDb = new ChatDb(cfg.paths.chat_db);
  try {
    switch (sub) {
      case "list":
      case "ls":
        await bnList(state, prefs, contacts, chatDb);
        return;
      case "show":
        await bnShow(prefs, cfg, requireBnKey(p), state, contacts, chatDb);
        return;
      case "enable":
      case "on":
        await bnEnable(prefs, cfg, requireBnKey(p));
        return;
      case "disable":
      case "off":
        await bnDisable(prefs, cfg, requireBnKey(p), getString(p, "reason") ?? "operator CLI");
        return;
      case "reset":
        await bnReset(prefs, requireBnKey(p));
        return;
      case "invoke":
        await bnInvoke(cfg, prefs, requireBnKey(p), {
          force: hasFlag(p, "force"),
          dryRun: hasFlag(p, "dry-run"),
          fireNow: hasFlag(p, "fire-now"),
          brief: getString(p, "brief"),
        });
        return;
      default:
        fail(`unknown sessions brownnose subcommand: ${sub}`);
        info(BN_USAGE);
        process.exit(2);
    }
  } finally {
    prefs.close();
    chatDb.close();
  }
}

function requireBnKey(p: Parsed): SessionKey {
  // `edmund sessions brownnose <verb> <key>` — verb is positional[1], key is positional[2].
  const key = p.positional[2];
  if (!key) {
    fail("missing session key");
    info(BN_USAGE);
    process.exit(2);
  }
  return key as SessionKey;
}

/** Human label for a session: contact name for DMs; chat name (or member
 *  names) for groups — never a bare guid. */
function bnLabel(sessionKey: SessionKey, contacts: ContactBook, chatDb: ChatDb): string {
  const id = chatIdFromKey(sessionKey);
  if (!isGroupSession(sessionKey)) return contacts.displayName(id) ?? id;
  const chatName = getChatDisplayName(chatDb, id);
  if (chatName) return chatName;
  const members = bnMembers(sessionKey, contacts, chatDb);
  if (members.length > 0) {
    const shown = members.slice(0, 3).join(", ");
    return members.length > 3 ? `${shown} +${members.length - 3}` : shown;
  }
  return `group ${id.slice(0, 12)}…`;
}

function bnMembers(sessionKey: SessionKey, contacts: ContactBook, chatDb: ChatDb): string[] {
  if (!isGroupSession(sessionKey)) return [];
  try {
    return getGroupParticipants(chatDb, chatIdFromKey(sessionKey)).map(
      (h) => contacts.displayName(h) ?? h,
    );
  } catch {
    return [];
  }
}

async function bnList(
  state: StateStore,
  prefs: GhostPrefsStore,
  contacts: ContactBook,
  chatDb: ChatDb,
): Promise<void> {
  section("brown-nose state");
  const sessions = state.listSessions();
  if (sessions.length === 0) {
    info("no sessions yet.");
    return;
  }
  const now = Date.now();
  const prefsByKey = new Map(prefs.list().map((p) => [p.sessionKey, p]));
  const data = sessions.map((s) => {
    const key = s.sessionKey as SessionKey;
    const pref = prefsByKey.get(key);
    const kindBadge = isGroupSession(key) ? badge("group", "info") : badge("dm", "muted");
    const snoozed = pref && snoozeActive(pref, s.lastInboundMs ?? 0, now);
    const lastFire = pref ? prefs.recentFires(key, 1)[0] : undefined;
    return [
      bnLabel(key, contacts, chatDb),
      kindBadge,
      bnCell(pref) + (snoozed ? ` ${color.cyan("zzz")}` : ""),
      rel(s.lastInboundMs ?? 0),
      lastFire
        ? `${rel(lastFire.firedAtMs)} ${color.dim(`(${lastFire.outcome ?? "pending"})`)}`
        : color.dim("—"),
      color.dim(s.sessionKey),
    ];
  });
  table(["who", "kind", "brown_nose", "last msg", "last fire", "key"], data);
  print("");
  const enrolled = prefsByKey.size;
  const enabled = [...prefsByKey.values()].filter((p) => p.enabled).length;
  info(
    `${enabled} enabled · ${enrolled - enabled} disabled · ${sessions.length - enrolled} not enrolled · ${color.cyan("zzz")} = ghost-snoozed`,
  );
}

function bnCell(p: BrownNosePrefs | undefined): string {
  if (!p) return color.dim("(not enrolled)");
  if (!p.enabled) {
    const reason = p.disabledReason ? color.dim(`: ${p.disabledReason}`) : "";
    return `${color.yellow("off")}${reason}`;
  }
  return `${color.green("on")} ${color.dim(`(cap ${p.weeklyCap}/wk, ×${p.cooldownMultiplier.toFixed(1)})`)}`;
}

async function bnShow(
  prefs: GhostPrefsStore,
  cfg: ReturnType<typeof loadConfig>,
  sessionKey: SessionKey,
  state: StateStore,
  contacts: ContactBook,
  chatDb: ChatDb,
): Promise<void> {
  const label = bnLabel(sessionKey, contacts, chatDb);
  section(`brownnose · ${label}`);
  kv("key", color.dim(sessionKey));
  const members = bnMembers(sessionKey, contacts, chatDb);
  if (members.length > 0) kv("members", members.join(", "));
  const session = state.getSession(sessionKey);
  kv("last inbound", session?.lastInboundMs ? rel(session.lastInboundMs) : color.dim("never"));
  kv("last outbound", session?.lastOutboundMs ? rel(session.lastOutboundMs) : color.dim("never"));

  const row = prefs.get(sessionKey);
  if (!row) {
    info("no brown_nose_prefs row for this session (not enrolled).");
    return;
  }
  const params = resolveIntensity(cfg.brown_nose.intensity);
  kv("enabled", row.enabled ? color.green("true") : color.yellow("false"));
  if (!row.enabled && row.disabledReason) {
    kv("disabled reason", row.disabledReason);
    if (row.disabledAtMs) kv("disabled at", new Date(row.disabledAtMs).toISOString());
  }
  if (snoozeActive(row, session?.lastInboundMs ?? 0, Date.now())) {
    kv(
      "snoozed",
      `${color.cyan("yes")} until ${new Date(row.snoozeUntilMs ?? 0).toLocaleString()} ${color.dim("(any new inbound voids it)")}`,
    );
  }
  kv("timezone", row.timezone);
  kv("weekly cap", row.weeklyCap);
  kv("cooldown ×", row.cooldownMultiplier.toFixed(1));
  kv("active hours", bnFormatActiveHours(row.activeHours));
  kv(
    "intensity",
    `${color.bold(String(cfg.brown_nose.intensity))} → ${params.cooldownHours}h cd, ${params.weeklyCap}/wk, sweep ${params.sweepMin}-${params.sweepMax}m`,
  );

  if (row.focusSuggestions.length > 0) {
    print("");
    section("focus topics");
    for (const s of row.focusSuggestions) {
      print(`  ${color.cyan("•")} ${s.topic} ${color.dim(`(used ${s.usageCount}× this week)`)}`);
    }
  }

  // Decision-log stats: where do this chat's ticks actually go?
  const decisions = readRecentDecisions(sessionKey, 100) as Array<
    Record<string, unknown> & { act: boolean; tickAtMs: number }
  >;
  let acts = 0;
  let gateNos = 0;
  let modelNos = 0;
  let snoozes = 0;
  for (const d of decisions) {
    const reason = typeof d.reason === "string" ? d.reason : "";
    if (d.act) acts++;
    else if (d.gate || /^(cooldown|active_hours|enabled|weekly_cap|no prefs)/.test(reason))
      gateNos++;
    else modelNos++;
    if (typeof d.snoozeUntilMs === "number") snoozes++;
  }
  print("");
  section(`stats (last ${decisions.length} decisions)`);
  kv("acts", acts);
  kv("model NOs (paid)", modelNos);
  kv("gate NOs (free)", gateNos);
  kv("snoozes set", snoozes);

  // Ghost workspace: running notes + staged work.
  const wsDir = `${sandboxDir(sessionKey)}/brownnose`;
  const notesPath = `${wsDir}/current.md`;
  if (existsSync(notesPath)) {
    print("");
    section("ghost notes (current.md)");
    const notes = (await Bun.file(notesPath).text()).trim();
    for (const line of notes.split("\n").slice(0, 30)) print(`  ${line}`);
  }
  const staged: string[] = [];
  for (const sub of ["drafts", "research"]) {
    const dir = `${wsDir}/${sub}`;
    if (!existsSync(dir)) continue;
    for (const f of new Bun.Glob("*").scanSync({ cwd: dir })) staged.push(`${sub}/${f}`);
  }
  if (staged.length > 0) {
    print("");
    section(`staged work (${staged.length})`);
    for (const f of staged) print(`  ${color.cyan("•")} ${wsDir}/${f}`);
  }

  const recent = prefs.recentFires(sessionKey, 10);
  print("");
  section(`fires (${recent.length})`);
  if (recent.length === 0) {
    info("none yet.");
  } else {
    for (const f of recent) {
      print(
        `  ${color.dim(new Date(f.firedAtMs).toLocaleString())} ${bnOutcomeBadge(f.outcome)} ${color.dim(f.tags.join(", "))}`,
      );
      print(`    ${f.brief}`);
    }
  }

  print("");
  section(
    `ghost decisions (${Math.min(decisions.length, 25)} of ${decisions.length}, newest first)`,
  );
  if (decisions.length === 0) {
    info("none yet.");
    return;
  }
  for (const d of decisions.slice(0, 25)) {
    const when = color.dim(new Date(d.tickAtMs).toLocaleString());
    if (d.act) {
      const tags = Array.isArray(d.tags) ? (d.tags as string[]).join(", ") : "";
      print(`  ${when} ${badge("ACT", "ok")} ${color.dim(tags)}`);
      if (typeof d.brief === "string") print(`    ${d.brief}`);
      if (Array.isArray(d.contextFiles) && d.contextFiles.length > 0) {
        print(`    ${color.dim(`staged: ${(d.contextFiles as string[]).join(", ")}`)}`);
      }
    } else {
      const reason = typeof d.reason === "string" ? d.reason : "(no reason)";
      const isGate = Boolean(
        d.gate || /^(cooldown|active_hours|enabled|weekly_cap|no prefs)/.test(reason),
      );
      const tag = isGate ? badge("gate", "muted") : badge("NO", "warn");
      const snooze =
        typeof d.snoozeUntilMs === "number"
          ? ` ${color.cyan(`zzz→${new Date(d.snoozeUntilMs).toLocaleString()}`)}`
          : "";
      print(`  ${when} ${tag}${snooze}`);
      print(`    ${color.dim(reason)}`);
    }
  }
}

function bnOutcomeBadge(outcome: FireRecord["outcome"]): string {
  if (outcome === "engaged") return badge("engaged", "ok");
  if (outcome === "pushed_back") return badge("pushed_back", "fail");
  if (outcome === "ignored") return badge("ignored", "warn");
  if (outcome === "vetoed") return badge("vetoed", "muted");
  if (outcome === "error") return badge("error", "muted");
  return badge("pending", "muted");
}

function bnFormatActiveHours(hours: BrownNosePrefs["activeHours"]): string {
  if (hours.length === 0) return color.dim("(none — never fires)");
  return hours.map((w) => `${w.dow} ${w.start}-${w.end}`).join(", ");
}

async function bnEnable(
  prefs: GhostPrefsStore,
  cfg: ReturnType<typeof loadConfig>,
  sessionKey: SessionKey,
): Promise<void> {
  const existing = prefs.get(sessionKey);
  if (!existing) {
    prefs.upsert(sessionKey, {
      enabled: true,
      defaultsIfNew: bnDefaultsFromConfig(cfg, sessionKey),
    });
  } else {
    prefs.upsert(sessionKey, {
      enabled: true,
      disabledReason: null,
      disabledAtMs: null,
    });
  }
  ok(`enabled brown_nose for ${color.dim(sessionKey)}`);
}

async function bnDisable(
  prefs: GhostPrefsStore,
  cfg: ReturnType<typeof loadConfig>,
  sessionKey: SessionKey,
  reason: string,
): Promise<void> {
  const existing = prefs.get(sessionKey);
  const update = {
    enabled: false,
    disabledReason: reason,
    disabledAtMs: Date.now(),
  };
  if (!existing) {
    prefs.upsert(sessionKey, { ...update, defaultsIfNew: bnDefaultsFromConfig(cfg, sessionKey) });
  } else {
    prefs.upsert(sessionKey, update);
  }
  ok(`disabled brown_nose for ${color.dim(sessionKey)}`);
  info(`reason: ${color.dim(reason)}`);
}

async function bnReset(prefs: GhostPrefsStore, sessionKey: SessionKey): Promise<void> {
  prefs.remove(sessionKey);
  ok(`cleared brown_nose_prefs for ${color.dim(sessionKey)}`);
}

async function bnInvoke(
  cfg: ReturnType<typeof loadConfig>,
  prefs: GhostPrefsStore,
  sessionKey: SessionKey,
  opts: { force: boolean; dryRun: boolean; fireNow: boolean; brief?: string },
): Promise<void> {
  section(`ghost tick · ${sessionKey}`);
  const flags: string[] = [];
  if (opts.force) flags.push("force (bypass budgets)");
  if (opts.dryRun) flags.push("dry-run (no haiku)");
  if (opts.fireNow) flags.push("fire-now (no jitter)");
  if (opts.brief) flags.push(`brief override (skip ghost)`);
  if (flags.length > 0) info(flags.join(" · "));

  // --brief path: skip the ghost entirely and inject an operator-
  // supplied act:true decision. Used for manual "fire one now" testing
  // when the ghost is correctly declining and you want to exercise the
  // downstream fire path.
  if (opts.brief) {
    const decision = {
      act: true as const,
      tickAtMs: Date.now(),
      fireAtMs: opts.fireNow ? Date.now() + 500 : Date.now() + 30_000,
      brief: opts.brief,
      tags: ["operator-injected"],
      expiresAtMs: Date.now() + 60 * 60_000,
      confidence: "medium" as const,
    };
    ok("operator-injected decision: ACT");
    kv("fire at", new Date(decision.fireAtMs).toISOString());
    kv("brief", opts.brief);
    const crons = new CronStore(cfg.paths.data_dir);
    const res = enqueueBrownNoseFire({
      sessionKey,
      decision,
      config: cfg,
      crons,
      prefsStore: prefs,
      noJitter: opts.fireNow,
    });
    print("");
    if (res.enqueued) {
      ok(`enqueued cron ${color.cyan(res.jobId)}`);
      info(`fires at ${color.dim(new Date(res.jitteredFireAtMs).toISOString())}`);
    } else {
      fail(`enqueue declined: ${res.reason}`);
    }
    return;
  }

  const chatDb = new ChatDb(cfg.paths.chat_db);
  const contacts = new ContactBook(cfg.contacts, new AddressBook());
  const decision = await runGhostTick(
    {
      sessionKey,
      bypassActiveHours: true,
      bypassBudgets: opts.force,
      dryRun: opts.dryRun,
    },
    { config: cfg, chatDb, contacts, prefs },
  );

  print("");
  if (decision.act) {
    ok("ghost decision: ACT");
    kv("fire at", new Date(decision.fireAtMs).toISOString());
    kv("expires at", new Date(decision.expiresAtMs).toISOString());
    kv("confidence", decision.confidence);
    kv("tags", decision.tags.join(", ") || color.dim("—"));
    print("");
    info("brief:");
    print(`  ${decision.brief}`);

    const crons = new CronStore(cfg.paths.data_dir);
    const enqDecision = opts.fireNow ? { ...decision, fireAtMs: Date.now() + 500 } : decision;
    const res = enqueueBrownNoseFire({
      sessionKey,
      decision: enqDecision,
      config: cfg,
      crons,
      sessionPrefs: prefs.get(sessionKey),
      prefsStore: prefs,
      noJitter: opts.fireNow,
    });
    print("");
    if (res.enqueued) {
      ok(`enqueued cron ${color.cyan(res.jobId)}`);
      info(`fires at ${color.dim(new Date(res.jitteredFireAtMs).toISOString())}`);
    } else {
      fail(`enqueue declined: ${res.reason}`);
    }
  } else {
    info(`ghost decision: ${color.yellow("NO")}`);
    print(`  reason: ${color.dim(decision.reason)}`);
  }
}

function bnDefaultsFromConfig(
  cfg: ReturnType<typeof loadConfig>,
  sessionKey: SessionKey,
): {
  enabled: boolean;
  activeHours: BrownNosePrefs["activeHours"];
  timezone: string;
  weeklyCap: number;
} {
  const isGroup = isGroupSession(sessionKey);
  const params = resolveIntensity(cfg.brown_nose.intensity);
  return {
    enabled: isGroup
      ? cfg.brown_nose.groups_enabled_by_default
      : cfg.brown_nose.dms_enabled_by_default,
    activeHours: isGroup
      ? []
      : [
          { dow: "mon", start: "09:00", end: "19:00" },
          { dow: "tue", start: "09:00", end: "19:00" },
          { dow: "wed", start: "09:00", end: "19:00" },
          { dow: "thu", start: "09:00", end: "19:00" },
          { dow: "fri", start: "09:00", end: "19:00" },
        ],
    timezone: cfg.brown_nose.default_timezone,
    weeklyCap: params.weeklyCap,
  };
}

async function showPending(state: StateStore, contacts: ContactBook): Promise<void> {
  const acks = state.listInboundAcks();
  section("orphaned inbound acks");
  if (acks.length === 0) {
    info("none — all acks have been cleared.");
    return;
  }
  info(
    `\n${color.bold(String(acks.length))} orphaned row(s) — survived a crash or haven't yet been answered:\n`,
  );
  for (const a of acks) {
    const id = chatIdFromKey(a.sessionKey);
    const label = isGroupSession(a.sessionKey)
      ? `group ${id.slice(0, 12)}…`
      : (contacts.displayName(id) ?? id);
    const age = Math.round((Date.now() - a.createdMs) / 1000);
    const ageStr =
      age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
    info(`  rowId=${a.rowId}  session=${label}  age=${ageStr}`);
  }
  info(
    `\nThese will be replayed through the catch-up coalescer on the next boot.\nUse ${color.cyan("edmund sessions reset <key>")} to force a cold-start if they're stuck.`,
  );
}
