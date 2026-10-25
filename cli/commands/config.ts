/**
 * `edmund config show [section]` — print the loaded config with secrets masked.
 * `edmund config path` — print the resolved config.toml path.
 * `edmund config tidy` — lay config.toml out by how often each part changes
 *   (src/config/layout.ts), keeping a backup; values are never changed.
 *
 * Deeper edits happen in the web dashboard's Settings page, where a TOML
 * roundtrip writes a backup on save. The CLI intentionally doesn't expose a
 * `config set` — it's easy to corrupt TOML from a shell quote.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { loadConfig } from "../../src/config/config.ts";
import { formatChecked, machineNotes } from "../../src/config/layout.ts";
import type { Parsed } from "../args.ts";
import { color, fail, info, ok, print, section } from "../ui.ts";

const SECRET_KEYS = ["openai", "gemini", "elevenlabs", "openrouter"] as const;

export async function configCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0] ?? "show";
  if (sub === "path") {
    print(resolve(process.cwd(), "config.toml"));
    return;
  }
  if (sub === "show") {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const only = p.positional[1];
    const sectionKeys = only ? [only] : Object.keys(cfg);
    for (const k of sectionKeys) {
      const val = (cfg as Record<string, unknown>)[k];
      if (val === undefined) continue;
      section(`[${k}]`);
      printValue(k, val, "");
    }
    print("");
    info("edit config.toml directly, or use the dashboard Settings page for validated saves");
    return;
  }
  if (sub === "tidy") {
    const path = resolve(process.cwd(), "config.toml");
    if (!existsSync(path)) {
      fail(`no config at ${path}`);
      process.exit(1);
    }
    const raw = readFileSync(path, "utf8");
    let text: string;
    try {
      text = formatChecked(parse(raw) as Record<string, unknown>, machineNotes(raw));
    } catch (err) {
      fail(`${(err as Error).message}; config.toml left as it was`);
      process.exit(1);
    }
    if (text === raw) {
      ok("config.toml is already laid out");
      return;
    }
    const backup = `${path}.bak-${Date.now()}`;
    copyFileSync(path, backup);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    ok(`config.toml laid out by tier; every value unchanged (backup: ${backup})`);
    return;
  }
  info(`usage: edmund config [show [section] | path | tidy]`);
}

function printValue(key: string, value: unknown, indent: string): void {
  if (value === null || value === undefined) {
    print(`${indent}${color.dim(key)} ${color.dim("—")}`);
    return;
  }
  if (Array.isArray(value)) {
    print(`${indent}${color.dim(key)} ${color.gray(`[${value.length}]`)}`);
    for (const v of value) print(`${indent}  ${color.dim("-")} ${String(v)}`);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) printValue(k, v, `${indent}  `);
    return;
  }
  const shown =
    SECRET_KEYS.includes(key as (typeof SECRET_KEYS)[number]) && typeof value === "string" && value
      ? `•••${value.slice(-4)}`
      : String(value);
  print(`${indent}${color.dim(key.padEnd(22))}${shown}`);
}
