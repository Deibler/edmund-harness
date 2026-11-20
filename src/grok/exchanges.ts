import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GrokCaller, callerTag } from "./caller.ts";

/**
 * The record of what was said through Grok.
 *
 * Connector requests run in the person's DM session, so the conversation itself
 * already holds them; nothing reads this log back into a prompt. It is the audit
 * trail: who asked what through the connector, what came back, and whether the
 * answer was spoken on the line or texted after it gave up. It is also what
 * `check_edmund` reads to say what Edmund has texted since the line closed. Append-only JSONL,
 * read from the tail, so it stays cheap however long it runs.
 */
export type Exchange = {
  atMs: number;
  handle: string;
  /** What the person said. */
  said: string;
  /** What Edmund answered. Empty when he answered with a tool and no words. */
  reply: string;
  /** "spoken" came back on the line; "texted" arrived after the line gave up. */
  via: "spoken" | "texted";
  /** Which connector tool started it. Absent on old lines and means "ask". */
  kind?: "ask" | "tell" | "report";
  /** Who called, from the key they presented. Absent on old lines. */
  caller?: GrokCaller;
};

const TAIL_LINES = 200;

export class ExchangeLog {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "grok", "exchanges.jsonl");
  }

  record(entry: Exchange): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  /** Newest `limit` exchanges after `sinceMs`, oldest first. */
  since(sinceMs: number, limit: number): Exchange[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").trimEnd().split("\n").slice(-TAIL_LINES);
    const out: Exchange[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Exchange;
        if (e.atMs > sinceMs) out.push(e);
      } catch {
        // A torn final line from a crash mid-write; the rest are intact.
      }
    }
    return out.slice(-limit);
  }
}

/** One exchange as a log line. */
export function describeExchange(e: Exchange): string {
  const t = new Date(e.atMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  // Old lines carry no caller and keep the old "they".
  const who = e.caller ? callerTag(e.caller) : "they";
  const said = `  [${t}] ${who} said: ${JSON.stringify(e.said)}`;
  const reply = e.reply
    ? `  you ${e.via === "texted" ? "texted" : "answered aloud"}: ${JSON.stringify(e.reply)}`
    : "  you handled it with tools (no spoken reply)";
  return `${said}\n${reply}`;
}
