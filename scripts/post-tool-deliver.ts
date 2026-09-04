#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook — auto-delivers any file the model produced.
 *
 * Tool results are scanned for absolute paths
 * pointing at the session's media archive (sandbox/<id>/{images,videos,
 * voice-memos}/). Each unique path is sent once through the daemon's bridge so
 * the user receives the file without requiring the model to explicitly call
 * `send_attachment`.
 *
 * Contract:
 *   - stdin: JSON {tool_name, tool_input, tool_response}
 *   - exit 0: always (hook failures must never block tool execution)
 *
 * Dedupe state lives at `<data_dir>/delivered/<session-slug>.json` — a
 * small file-scoped set so repeated mentions of the same path (tool calls
 * that log it again) don't trigger multiple sends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { loadConfig } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { configureSendVerification, sendMessage } from "../src/imessage/send.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import { chatGuidsForSession } from "../src/sessions/session-scope.ts";

type Payload = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
};

const sandbox = process.env.EDMUND_SANDBOX_PATH ? resolve(process.env.EDMUND_SANDBOX_PATH) : null;
const dataDir = process.env.EDMUND_DATA_DIR ? resolve(process.env.EDMUND_DATA_DIR) : null;
const sessionKey = process.env.EDMUND_SESSION_KEY ?? "";

if (!sandbox || !dataDir || !sessionKey) process.exit(0);

// Only scan results from tools that actually produce deliverable media.
const TRUSTED_TOOLS = new Set([
  "mcp__edmund-harness__generate_image",
  "mcp__edmund-harness__generate_video",
  "mcp__edmund-harness__generate_audio",
]);

const DELIVERABLE_SUBDIRS = ["images", "videos", "voice-memos"];

type DeliveryTarget = { isGroup: boolean; to: string; chatGuid?: string };

function parseTarget(key: string): DeliveryTarget | null {
  if (key.startsWith("imessage:dm:"))
    return { isGroup: false, to: key.slice("imessage:dm:".length) };
  if (key.startsWith("imessage:group:"))
    return { isGroup: true, to: key.slice("imessage:group:".length) };
  return null;
}

/**
 * The chat.db GUID for this session's conversation.
 *
 * A group already is its GUID. A DM used to travel as the bare handle and let
 * IMCore pick a chat, which for our own address meant the note-to-self thread —
 * the file was gone and the hook still logged "ok". Resolving the GUID here
 * addresses auto-delivered media at the same chat a reply goes to.
 *
 * Contacts come from config alone: the hook is a short-lived process per tool
 * call, and reading the macOS address book to widen alias matching is not worth
 * the startup. An unresolvable handle returns undefined and sends as it did
 * before rather than failing.
 */
function resolveChatGuid(target: DeliveryTarget): string | undefined {
  if (target.isGroup) return target.to;
  let chatDb: ChatDb | undefined;
  try {
    const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
    chatDb = new ChatDb(config.paths.chat_db);
    const guids = chatGuidsForSession(sessionKey, chatDb, new ContactBook(config.contacts));
    return guids[0];
  } catch {
    return undefined;
  } finally {
    chatDb?.close?.();
  }
}

function readPayload(): Payload {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? (JSON.parse(raw) as Payload) : {};
  } catch {
    return {};
  }
}

function extractText(resp: unknown): string {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    // Claude Code passes the tool result structure through; dig for .content[].text
    const obj = resp as { content?: Array<{ type?: string; text?: string }>; output?: unknown };
    if (Array.isArray(obj.content)) {
      return obj.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
    }
    if (obj.output) return extractText(obj.output);
    try {
      return JSON.stringify(resp);
    } catch {
      return "";
    }
  }
  return "";
}

function extractDeliverablePaths(text: string): string[] {
  const found = new Set<string>();
  // Two strategies:
  //  1. Any absolute path that sits under one of the sandbox media subdirs.
  //  2. `MEDIA: <path>` directives (cheap to support).
  const pathRe = /(\/[^\s"'<>]+)/g;
  for (const m of text.matchAll(pathRe)) {
    const p = m[1]!.replace(/[.,;)]+$/, ""); // strip trailing punctuation
    if (!isAbsolute(p)) continue;
    for (const sub of DELIVERABLE_SUBDIRS) {
      const prefix = `${sandbox}/${sub}/`;
      if (p.startsWith(prefix) && existsSync(p)) {
        found.add(p);
        break;
      }
    }
  }
  return [...found];
}

function loadDedupe(sessionSlug: string): { path: string; set: Set<string> } {
  const dir = join(dataDir!, "delivered");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionSlug}.json`);
  if (!existsSync(path)) return { path, set: new Set() };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { sent?: string[] };
    return { path, set: new Set(data.sent ?? []) };
  } catch {
    return { path, set: new Set() };
  }
}

function saveDedupe(path: string, set: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ sent: [...set] }, null, 2));
}

/**
 * Sends one file through the daemon's bridge.
 *
 * The hook runs as its own process and so does not hold the bridge; the send
 * crosses the daemon's control socket like every other Messages operation.
 */
async function deliver(target: DeliveryTarget, file: string): Promise<boolean> {
  // Detection without the heal: this process cannot restart imagent (the
  // daemon owns the supervisor), but a misdelivered file should still come
  // back as a failure in the diag log instead of "ok".
  try {
    const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
    configureSendVerification({
      chatDbPath: config.paths.chat_db,
      selfHandles: config.self.handles,
    });
  } catch {}
  const result = await sendMessage({
    to: target.to,
    isGroup: target.isGroup,
    chatGuid: target.chatGuid,
    attachments: [file],
  });
  // Persistent diag so we can see what happened in the real hook context —
  // Claude Code's hook stdout/stderr capture is unreliable.
  try {
    const diagPath = join(dataDir!, "delivered", "_hook.log");
    const outcome = result.ok ? "ok" : `error="${result.error}"`;
    writeFileSync(diagPath, `${new Date().toISOString()} deliver ${file} → ${outcome}\n`, {
      flag: "a",
    });
  } catch {}
  if (result.ok) return true;
  process.stderr.write(`[post-tool-deliver] send failed for ${file}: ${result.error}\n`);
  return false;
}

const payload = readPayload();
const name = payload.tool_name ?? "";
if (!TRUSTED_TOOLS.has(name)) process.exit(0);

const target = parseTarget(sessionKey);
if (!target) process.exit(0);

const text = extractText(payload.tool_response);
const paths = extractDeliverablePaths(text);
if (paths.length === 0) process.exit(0);

// Resolved once, after we know there is something to send — the lookup opens
// chat.db, and most hook invocations exit above without needing it.
target.chatGuid = resolveChatGuid(target);

const sessionSlug = sessionKey.replace(/[^A-Za-z0-9]+/g, "-");
const { path: dedupePath, set: sent } = loadDedupe(sessionSlug);

for (const p of paths) {
  if (sent.has(p)) continue;
  const ok = await deliver(target, p);
  if (ok) {
    console.log(`[post-tool-deliver] auto-sent ${p}`);
    sent.add(p);
  }
}
saveDedupe(dedupePath, sent);
process.exit(0);
