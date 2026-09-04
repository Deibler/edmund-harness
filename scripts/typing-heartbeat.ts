#!/usr/bin/env bun
/**
 * Keep the iMessage typing bubble alive while Claude works.
 *
 * Typing indicators fade after ~5-8 seconds, so for a realistic "actively
 * typing" feel across a 15-60s turn the indicator is re-set every few seconds.
 * Runs detached so the `activate_typing` MCP tool can fire and forget.
 *
 * Lifecycle:
 *   - Spawned detached by the `activate_typing` MCP tool
 *   - Target and pidfile arrive via env: TYPING_CHAT, TYPING_PIDFILE
 *   - Loops for up to MAX_MS, a hard cap so a runaway can never last forever
 *   - Exits early if the pidfile is removed (an external cancel) or the bridge
 *     refuses the request
 *   - Clears the indicator on the way out
 *
 * Every pulse goes through the daemon's control socket, like all other Messages
 * operations, rather than shelling out per pulse.
 */

import { existsSync, rmSync } from "node:fs";

import { invoke } from "../src/imessage/bridge/index.ts";

const MAX_MS = 90_000;
const INTERVAL_MS = 4_000;

const chat = process.env.TYPING_CHAT;
const pidFile = process.env.TYPING_PIDFILE;
if (!chat || !pidFile) {
  console.error("typing-heartbeat: missing TYPING_CHAT or TYPING_PIDFILE");
  process.exit(1);
}

const started = Date.now();

while (Date.now() - started < MAX_MS) {
  if (!existsSync(pidFile)) break;
  try {
    await invoke("typing", { chat, typing: true });
  } catch (err) {
    // The daemon is down, or Messages refused. Retrying every 4s for 90s would
    // only be noise for what is a cosmetic bubble.
    console.error(`typing-heartbeat: ${err instanceof Error ? err.message : String(err)}`);
    break;
  }
  await Bun.sleep(INTERVAL_MS);
}

// An indicator outlives whoever set it, so leaving without clearing would park a
// bubble on the other side until IMCore timed it out on its own.
try {
  await invoke("typing", { chat, typing: false });
} catch {
  /* nothing left to clear it with */
}

try {
  if (existsSync(pidFile)) rmSync(pidFile);
} catch {}
