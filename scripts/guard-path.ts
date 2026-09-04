#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook. Rejects file-writing tool calls that would
 * escape the per-session sandbox. Read / Glob / Grep are allowed anywhere
 * so the model can still see skills, persona, envelope, and recent messages.
 *
 * Contract (per Claude Code hooks spec):
 *   - receives JSON on stdin:  { tool_name, tool_input, ... }
 *   - exit 0                → allow
 *   - exit 2 + stderr text  → block with message fed back to the model
 *
 * Scope rules (all case-sensitive, resolved absolute):
 *   Write / Edit / NotebookEdit:
 *       path must sit under EDMUND_SANDBOX_PATH or EDMUND_DATA_DIR, AND
 *       must NOT sit under a protected media subdir (the model may neither
 *       create, overwrite, nor edit files there — only MCP tools add to
 *       those, and the user expects the archive to be immutable).
 *   Bash:
 *       scan for redirections (`>`, `>>`, `tee`) and common mutating commands
 *       (rm, mv, cp, mkdir, touch, ln) — reject if they target anywhere
 *       outside sandbox / data dir, OR if they target a protected media
 *       subdir (blocks deletion / renaming / overwrite of generated and
 *       received media). Relative paths are resolved against the subprocess
 *       cwd (which the harness sets to the sandbox).
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type Payload = {
  tool_name: string;
  tool_input?: Record<string, unknown>;
};

const sandbox = process.env.EDMUND_SANDBOX_PATH ? resolve(process.env.EDMUND_SANDBOX_PATH) : null;
const dataDir = process.env.EDMUND_DATA_DIR ? resolve(process.env.EDMUND_DATA_DIR) : null;
const cwd = process.env.EDMUND_SANDBOX_PATH ?? process.cwd();

if (!sandbox) {
  // No sandbox configured → hook cannot enforce; fail safe by allowing.
  process.exit(0);
}

const ALLOWED_ROOTS = [sandbox, dataDir].filter(Boolean) as string[];

// Media archives the model must not mutate. Generation (MCP tools) and
// inbound copy (main.ts) populate these directly, bypassing Claude Code's
// Write/Bash tools — so blocking here doesn't disrupt normal flow. It only
// prevents the model from deleting, renaming, or overwriting the archive.
const PROTECTED_SUBDIRS = [
  "images",
  "videos",
  "voice-memos",
  "received-images",
  "received-videos",
  "received-audio",
  "received-files",
];
const PROTECTED_ROOTS = PROTECTED_SUBDIRS.map((s) => `${sandbox}/${s}`);

function absolutize(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function inAllowedRoot(p: string): boolean {
  const abs = absolutize(p);
  return ALLOWED_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));
}

function inProtectedArchive(p: string): boolean {
  const abs = absolutize(p);
  return PROTECTED_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));
}

function block(message: string): never {
  process.stderr.write(`[guard-path] blocked: ${message}\n`);
  process.exit(2);
}

function readPayload(): Payload {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) return { tool_name: "" };
  return JSON.parse(raw) as Payload;
}

const payload = readPayload();
const name = payload.tool_name;
const input = payload.tool_input ?? {};

if (name === "Write" || name === "Edit" || name === "NotebookEdit") {
  const path =
    (input.file_path as string | undefined) ?? (input.notebook_path as string | undefined) ?? "";
  if (!path) process.exit(0);
  if (!inAllowedRoot(path)) {
    block(
      `${name} → ${path}\nOnly writes inside the sandbox (${sandbox}) or harness data dir are allowed.`,
    );
  }
  if (inProtectedArchive(path)) {
    block(
      `${name} → ${path}\nThe media archive (images/, videos/, voice-memos/, received-*/) is read-only. Generated media is written by MCP tools (\`generate_image\`, \`synthesize_speech\`, etc.) and inbound copies are handled by the harness. Don't edit, delete, or overwrite them.`,
    );
  }
  process.exit(0);
}

if (name === "Bash") {
  const cmd = (input.command as string | undefined) ?? "";
  if (!cmd) process.exit(0);

  type Target = { path: string; op: "write" | "mutate" };
  const targets: Target[] = [];

  const redirect = /(?:^|[\s;&|`(])(?:>>?|\|?tee(?:\s+-a)?)\s+("[^"]+"|'[^']+'|\S+)/g;
  for (const m of cmd.matchAll(redirect)) {
    targets.push({ path: stripQuotes(m[1]!), op: "write" });
  }

  // Separate regex per mutator so we can tell "delete" from "move destination".
  const mutator =
    /(?:^|[\s;&|`(])(rm|mv|cp|mkdir|touch|ln|chmod|chown|rmdir)((?:\s+-\S+)*)\s+([^\n;&|]+)/g;
  for (const m of cmd.matchAll(mutator)) {
    const verb = m[1]!;
    const tail = m[3]!.trim();
    const tokens = tail.split(/\s+/).filter((t) => !t.startsWith("-"));
    for (const token of tokens) {
      targets.push({ path: stripQuotes(token), op: "mutate" });
    }
    // Extra safety: rm/rmdir on a protected archive path is a deletion attempt;
    // we want the error message to reflect that, handled below via isProtected.
    if (verb === "rm" || verb === "rmdir") {
      // already tagged "mutate"; the archive check catches it.
    }
  }

  for (const { path: t, op } of targets) {
    if (t === "/dev/null" || t === "/dev/stdout" || t === "/dev/stderr") continue;
    if (/^&?\d+$/.test(t)) continue;
    if (!inAllowedRoot(t)) {
      block(
        `Bash → ${op} ${t}\nCommand: ${cmd}\nWrites must target the sandbox (${sandbox}) or harness data dir.`,
      );
    }
    if (inProtectedArchive(t)) {
      block(
        `Bash → ${op} ${t}\nCommand: ${cmd}\nThe media archive (images/, videos/, voice-memos/, received-*/) is read-only. Never rm, mv, overwrite, or edit files there.`,
      );
    }
  }
}

process.exit(0);

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
