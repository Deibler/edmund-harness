import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type SessionKey,
  chatIdFromKey,
  isGroupSession,
  isTradingSession,
  orchestratorOfSession,
} from "../sessions/key.ts";

/**
 * Per-session scratch workspace at `sandbox/<slug>/`. Auto-created on first
 * message in a session. The model has full filesystem access here (bypassed
 * permissions) and is responsible for keeping it organized — create subdirs
 * for distinct projects, prune what's stale.
 *
 * Slug format:
 *   - Groups: `group_<chatGuidSlug>`
 *   - DMs:    `dm_<handleSlug>`
 *
 * Using a deterministic slug (not a hash) so directories are human-readable
 * from the filesystem.
 */

/** Resolved per call (not at import) so tests can point it at a temp dir
 *  via EDMUND_SANDBOX_ROOT — unit tests were writing ghost decisions into
 *  the REAL sandbox/ tree (543 fake rows polluting telemetry). */
function sandboxRoot(): string {
  return process.env.EDMUND_SANDBOX_ROOT ?? resolve(process.cwd(), "sandbox");
}

export function ensureSandbox(sessionKey: SessionKey, displayName: string | null): string {
  const dir = sandboxDir(sessionKey);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/README.md`, scaffoldReadme(sessionKey, displayName));
  }
  return dir;
}

export function sandboxDir(sessionKey: SessionKey): string {
  const id = chatIdFromKey(sessionKey);
  const prefix = isTradingSession(sessionKey)
    ? "trading"
    : isGroupSession(sessionKey)
      ? "group"
      : "dm";
  // Named orchestrators get their own sandbox tree — without this,
  // `orch:desmond:dm:<handle>` and `imessage:dm:<handle>` would collide on
  // the same `dm_<handle>` directory and leak scratch files across personas.
  const okey = orchestratorOfSession(sessionKey);
  const ns = okey && okey !== "main" ? `orch_${slug(okey)}_` : "";
  return `${sandboxRoot()}/${ns}${prefix}_${slug(id)}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function scaffoldReadme(sessionKey: SessionKey, displayName: string | null): string {
  const kind = isGroupSession(sessionKey) ? "group chat" : "DM";
  const who = displayName ? ` with ${displayName}` : "";
  return [
    `# Sandbox — ${kind}${who}`,
    "",
    "Your private workspace for this conversation. Full filesystem access.",
    "",
    "## How to use",
    "",
    "- Make a subdirectory per distinct project (`webpage-birthday/`, `notes-2026-04/`).",
    "- Keep it tidy: when a project is done or abandoned, delete its folder.",
    "- Nothing here is visible to other conversations — it's scoped to this thread only.",
    "- If you build something shareable (a webpage, an image, a PDF), you can send it back with `send_attachment`.",
    "",
    "## What not to put here",
    "",
    "- Cross-conversation memory — that goes in the person file, not here.",
    "- Anything you want to remember in future sessions — use `remember_about_person`.",
    "",
    `_Auto-generated on first message; session key: \`${sessionKey}\`._`,
    "",
  ].join("\n");
}
