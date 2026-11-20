import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exchange, ExchangeLog } from "./exchanges.ts";
import { forVoice } from "./reply-text.ts";

/**
 * What `check_edmund` says: a few plain sentences read from state, never from a
 * model turn. Everything here is a file read or a loopback call with a short
 * leash, so the whole answer is back in well under a second.
 */

/** Answers newer than this are still "latest" to someone asking by voice. */
const RECENT_MS = 6 * 60 * 60_000;
const ANSWERS = 3;
const ANSWER_CHARS = 280;

export type StatusDeps = {
  exchanges: ExchangeLog;
  /** True while Edmund is in the middle of a turn in the person's DM session. */
  turnRunning: () => boolean;
  /** One line about the printer when it is printing; null when it is not or unknown. */
  printerLine: () => Promise<string | null>;
  now?: () => number;
};

export async function checkEdmund(deps: StatusDeps): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const parts: string[] = [];

  parts.push(
    deps.turnRunning()
      ? "Edmund is working on something right now."
      : "Edmund is not working on anything right now.",
  );

  const texted = deps.exchanges
    .since(now - RECENT_MS, 200)
    .filter((e) => e.via === "texted" && e.reply.trim() !== "")
    .slice(-ANSWERS);
  if (texted.length === 0) {
    parts.push("He has no new answers waiting.");
  } else {
    parts.push(
      texted.length === 1
        ? "Edmund texted one answer after the line closed."
        : `Edmund texted ${texted.length} answers after the line closed.`,
    );
    for (const e of texted) parts.push(describeAnswer(e, now));
  }

  const printer = await withLeash(deps.printerLine(), 800);
  if (printer) parts.push(printer);
  return parts.join(" ");
}

function describeAnswer(e: Exchange, now: number): string {
  const ago = agoPhrase(now - e.atMs);
  const reply = forVoice(speakable(e.reply), ANSWER_CHARS);
  if (e.kind === "report") return `${ago}, a Grok Bot's task came back, and Edmund said: ${reply}`;
  const said = forVoice(speakable(e.said), 80);
  return `${ago}, you asked "${said}" and Edmund said: ${reply}`;
}

/**
 * A texted answer was written for a screen. Read aloud, a link is a string of
 * letters and markdown is stray symbols, so both are reduced to what a person
 * would say.
 */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)\s]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}(?:#{1,6}|[-*•])\s+/gm, "")
    .replace(/[*`~]+/g, "");
}

export function agoPhrase(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "Just now";
  if (min === 1) return "A minute ago";
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h === 1 ? "An hour ago" : `${h} hours ago`;
}

async function withLeash<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => null),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One line about the printer, only while it is printing.
 *
 * The daemon's printer runtime (integrations/printer) already holds the live
 * connection and publishes its port and secret in `data/printer/runtime.json`;
 * one loopback GET on `/api/state` is the cheap read. Core does not import the
 * integration (deleting the package is a supported configuration), so the shape
 * is read defensively and anything unexpected means "say nothing". The direct
 * fallback the printer tools have, a fresh MQTT connection, is not cheap and is
 * skipped on purpose.
 */
export function printerLineFrom(
  dataDir: string,
  fetchImpl: typeof fetch = fetch,
  name = "The printer",
): () => Promise<string | null> {
  return async () => {
    const infoPath = join(dataDir, "printer", "runtime.json");
    if (!existsSync(infoPath)) return null;
    let info: { port?: number; secret?: string };
    try {
      info = JSON.parse(readFileSync(infoPath, "utf8"));
    } catch {
      return null;
    }
    if (!info.port || !info.secret) return null;
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/api/state`, {
      headers: { Authorization: `Bearer ${info.secret}` },
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { state?: Record<string, unknown> };
    return printingLine(body.state, name);
  };
}

const ACTIVE = new Set(["RUNNING", "PAUSE", "PREPARE", "SLICING"]);

export function printingLine(
  st: Record<string, unknown> | undefined,
  name = "The printer",
): string | null {
  if (!st || typeof st.gcodeState !== "string" || !ACTIVE.has(st.gcodeState)) return null;
  const task = typeof st.taskName === "string" && st.taskName ? ` "${st.taskName}"` : "";
  const label = st.gcodeState === "PAUSE" ? "paused" : "printing";
  const pct = typeof st.percent === "number" ? `, ${Math.round(st.percent)} percent done` : "";
  const left =
    typeof st.remainingMin === "number" && st.remainingMin >= 0
      ? `, ${minutes(st.remainingMin)} left`
      : "";
  const who = name.charAt(0).toUpperCase() + name.slice(1);
  return `${who} is ${label}${task}${pct}${left}.`;
}

function minutes(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} minutes`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} hours ${m} minutes` : `${h} hours`;
}
