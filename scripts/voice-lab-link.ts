#!/usr/bin/env bun
/**
 * Prints the voice lab's links, key included, for opening on another
 * computer on the network. The daemon's log leaves the key out, because the
 * page talks to Edmund as the operator.
 *
 *   bun scripts/voice-lab-link.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { lanAddresses } from "../src/calls/providers/web/server.ts";
import { loadConfig } from "../src/config/config.ts";

const config = loadConfig();
const keyPath = join(config.paths.data_dir, "voice-lab", "key");
if (!config.voice_lab.enabled) {
  console.error("The voice lab is off: set [voice_lab] enabled = true in config.toml.");
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`No key at ${keyPath} yet: the daemon makes it when the lab first starts.`);
  process.exit(1);
}
const key = readFileSync(keyPath, "utf8").trim();
const port = config.voice_lab.port;
for (const host of [`${hostname().replace(/\.local$/, "")}.local`, ...lanAddresses()]) {
  console.log(`https://${host}:${port}/?key=${key}`);
}
console.log(
  "\nThe certificate is self-signed: the browser warns once; continue past it (Chrome: Advanced, then Proceed).",
);
