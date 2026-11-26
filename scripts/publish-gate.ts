#!/usr/bin/env bun
/**
 * The publish gate, as the share script calls it (src/security/watch/gate.ts).
 *
 *   publish-gate.ts check <folder> --expire <minutes>
 *       Exit 0 when the folder may be published for that long. Otherwise
 *       prints why, one reason a line, and exits 1.
 *   publish-gate.ts register --port <n> --artifact <id> --path <folder> --expire <minutes>
 *       Write the door down, so the watch knows a tunnel to that port is one
 *       it let through. Run before the tunnel is started.
 *   publish-gate.ts verify <public url>
 *       Fetch the link with no key. It must be refused; exit 1 if it is not.
 *
 * It reads the same config and data folder as the daemon (EDMUND_CONFIG_PATH,
 * EDMUND_DATA_DIR, as every worker's environment has them).
 */
import { resolve } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { readWatchAddress } from "../src/security/watch/address.ts";
import { loadSecrets } from "../src/security/watch/canary.ts";
import { expiryProblem, registerDoor, scanFolder } from "../src/security/watch/gate.ts";
import { askWatch } from "../src/watch/server.ts";

const REPO = resolve(import.meta.dir, "..");
const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
}
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? resolve(REPO, "config.toml"));
const dataDir = resolve(process.env.EDMUND_DATA_DIR ?? config.paths.data_dir);

if (config.watch.mode === "off") process.exit(0);

if (command === "check") {
  const folder = resolve(positional[0] ?? "");
  const minutes = Number(flag("expire") ?? Number.NaN);
  const problems: string[] = [];
  const expiry = expiryProblem(minutes, config.watch.max_share_days, folder, dataDir);
  if (expiry) {
    problems.push(expiry);
    // Longer needs the operator's yes: the running watch texts them the
    // question, and their OK is what lets this folder through next time.
    const asked = (await askWatch(
      readWatchAddress(dataDir),
      "long-share",
      { folder, minutes },
      10_000,
    )) as {
      ok?: boolean;
      id?: string;
    } | null;
    if (asked?.ok && asked.id) {
      problems.push(
        `the operator has been asked (incident ${asked.id}); share again once they answer OK`,
      );
    }
  }
  for (const p of scanFolder(folder, loadSecrets(config, dataDir, REPO))) {
    problems.push(`${p.file} ${p.why}`);
  }
  if (problems.length === 0) process.exit(0);
  console.error("Not published. The publish gate found:");
  for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
  if (problems.length > 20) console.error(`  - and ${problems.length - 20} more`);
  console.error("Fix these and share again. Nothing was started.");
  // Observing only: say what would have stopped it, and let it through.
  process.exit(config.watch.mode === "enforce" ? 1 : 0);
}

if (command === "register") {
  const minutes = Number(flag("expire") ?? 0);
  const now = Date.now();
  registerDoor(dataDir, {
    port: Number(flag("port")),
    artifact: flag("artifact") ?? "",
    path: resolve(flag("path") ?? ""),
    expiresAt: now + (minutes > 0 ? minutes : config.watch.max_share_days * 1440) * 60_000,
    registeredAt: now,
  });
  process.exit(0);
}

if (command === "verify") {
  const url = positional[0] ?? "";
  try {
    // No key, and no cookies: what a stranger with only the address would get.
    const res = await fetch(url.split("?")[0]!, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) process.exit(0);
    console.error(`The link answered ${res.status} to a visitor with no key. It must refuse them.`);
  } catch (err) {
    console.error(`Could not check the link without a key: ${(err as Error).message}`);
  }
  process.exit(config.watch.mode === "enforce" ? 1 : 0);
}

console.error(
  "usage: publish-gate.ts check <folder> --expire <minutes> | register … | verify <url>",
);
process.exit(2);
