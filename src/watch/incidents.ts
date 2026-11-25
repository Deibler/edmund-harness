/**
 * What the watch raised, what it did about it, and what the operator said.
 *
 * An incident is one thing worth a person's attention: a trip the judge
 * called serious, a canary on its way out, a door nobody registered, a
 * visitor who got through. Each is written down with what the watch did in
 * response and how to reverse that, because everything the watch does on
 * its own is something that can be undone.
 *
 * The operator answers an alert in words:
 *
 *   OK        it was fine. Reverse what was done, and never raise this
 *             shape, for this target, in this chat again.
 *   UNDO      reverse what was done, this once. Nothing is learned.
 *   LOCKDOWN  close everything down (lockdown.ts).
 *
 * `OK` is also what people say to mean nothing in particular. So a bare OK
 * or UNDO counts only when it directly answers the alert: the alert is the
 * last thing the assistant said in that chat, and it is recent. Otherwise
 * the reply has to name the incident (`OK K7Q2`). LOCKDOWN needs neither:
 * it cannot be said by accident and one command reverses it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { watchDir } from "../security/watch/state.ts";
import type { VerdictLevel } from "./judge.ts";

export type UndoStep =
  | { kind: "resume-session"; session: string }
  | { kind: "restore-file"; path: string; from: string }
  | { kind: "restart"; detail: string; command: string }
  | { kind: "unblock"; target: string };

export type Incident = {
  id: string;
  at: number;
  /** The chat, the visitor, or the part of the machine it concerns. */
  where: string;
  kind: string;
  tier: "serious" | "notable";
  /** What was seen, in a sentence. */
  what: string;
  /** Who decided it mattered: the judge's level, or `rule` when no judgment was needed. */
  verdict: VerdictLevel | "rule" | "none";
  /** The judge's sentence, when there was one. */
  judged: string;
  /** What an OK allows from now on. Empty when there is nothing to learn. */
  pattern: string;
  /** What the watch did, each in a few words. */
  did: string[];
  undo: UndoStep[];
  status: "open" | "ok" | "undone";
  drill?: true;
};

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Four characters that cannot be mistaken for a word or for each other. */
export function newIncidentId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 4; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return id;
}

/** How long after an alert a bare OK or UNDO is taken as its answer. */
const DIRECT_REPLY_MS = 30 * 60_000;
/** How long an incident can still be answered by name. */
const OPEN_MS = 7 * 24 * 3_600_000;

export type Reply =
  | { word: "ok" | "undo"; incident: Incident }
  | { word: "lockdown" | "lockdown-off" };

/**
 * What an operator's message means to the watch, or null when it is an
 * ordinary message for the assistant. `lastSaidWasAlert` is whether the
 * newest thing the assistant sent in that chat is the alert for
 * `open[0]`: only then does a bare word answer it.
 */
export function readReply(
  text: string,
  open: Incident[],
  lastSaidWasAlert: boolean,
  now: number,
): Reply | null {
  const said = text.trim().replace(/[.!]+$/, "");
  if (/^lockdown$/i.test(said)) return { word: "lockdown" };
  if (/^lockdown\s+off$/i.test(said)) return { word: "lockdown-off" };
  const m = /^(ok|okay|undo)(?:\s+#?([A-Za-z0-9]{4}))?$/i.exec(said);
  if (!m) return null;
  const word = m[1]!.toLowerCase() === "undo" ? "undo" : "ok";
  const live = open.filter((i) => i.status === "open" && now - i.at < OPEN_MS);
  if (m[2]) {
    const named = m[2].toUpperCase();
    const incident = live.find((i) => i.id === named);
    // "ok 2pm?" is not addressed to the watch: only an id that exists counts.
    return incident ? { word, incident } : null;
  }
  const newest = live[0];
  if (!newest || !lastSaidWasAlert || now - newest.at > DIRECT_REPLY_MS) return null;
  return { word, incident: newest };
}

/** The text sent to the operator: what happened, where, what was done, and how to answer. */
export function alertText(incident: Incident, observeOnly: boolean): string {
  const lines = [
    `${incident.drill ? "DRILL. " : ""}Security ${incident.tier === "serious" ? "alert" : "note"} ${incident.id}: ${incident.what}`,
    `Where: ${incident.where}`,
  ];
  if (incident.verdict === "serious" || incident.verdict === "suspicious") {
    lines.push(`Reviewed as ${incident.verdict}: ${incident.judged}`);
  }
  if (observeOnly) lines.push("Watch is in observe mode: nothing was stopped.");
  else if (incident.did.length > 0) lines.push(`Done: ${incident.did.join("; ")}.`);
  const words = [
    `OK ${incident.id} (it was fine${incident.pattern ? ", don't raise it again" : ""})`,
    ...(incident.undo.length > 0 ? [`UNDO ${incident.id} (reverse what I did)`] : []),
    "LOCKDOWN",
  ];
  lines.push(`Reply ${words.join(", ")}.`);
  return lines.join("\n");
}

/** A marker that says "this message is an alert for incident X", to recognise a direct reply to it. */
export function alertMarker(id: string): string {
  return `Security alert ${id}:`;
}

/** Incidents, newest first, kept as a line a time so that nothing is lost in a crash. */
export class IncidentLog {
  private items: Incident[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(watchDir(dataDir), { recursive: true });
    this.file = join(watchDir(dataDir), "incidents.jsonl");
    try {
      const byId = new Map<string, Incident>();
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const incident = JSON.parse(line) as Incident;
          // A later line for the same id is its newer state.
          byId.set(incident.id, incident);
        } catch {}
      }
      this.items = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, 500);
    } catch {
      // No incidents yet.
    }
  }

  /** Newest first. */
  all(): Incident[] {
    return this.items;
  }

  open(): Incident[] {
    return this.items.filter((i) => i.status === "open");
  }

  /** Record a new incident, or the new state of one already recorded. */
  save(incident: Incident): void {
    const at = this.items.findIndex((i) => i.id === incident.id);
    if (at >= 0) this.items[at] = incident;
    else this.items.unshift(incident);
    try {
      appendFileSync(this.file, `${JSON.stringify(incident)}\n`);
    } catch {
      // The log line in the security channel is the other copy.
    }
  }
}
