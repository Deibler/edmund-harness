#!/usr/bin/env bun
/**
 * Usage: bun run dashboard:set-pin <pin>
 *
 * Hashes the given PIN with Bun.password (argon2id) and writes
 * `[dashboard] pin_hash` into config.toml. Refuses to run if <pin> is missing
 * or obviously too short to be meaningful.
 */

import { hashPin } from "../auth.ts";
import { writeConfig } from "../services/configIO.ts";
import { readConfigRaw } from "../services/configIO.ts";

const pin = process.argv[2];
if (!pin) {
  console.error("usage: bun run dashboard:set-pin <pin>");
  process.exit(2);
}
if (pin.length < 4 || pin.length > 64) {
  console.error("PIN must be 4 to 64 characters");
  process.exit(2);
}

const hash = await hashPin(pin);
const current = readConfigRaw();
const dash = (current.dashboard ?? {}) as Record<string, unknown>;
dash.pin_hash = hash;
current.dashboard = dash;
await writeConfig(current);
console.log("✓ PIN updated");
console.log("  start the dashboard with: bun run dashboard:dev");
