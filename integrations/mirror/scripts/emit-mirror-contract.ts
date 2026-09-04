#!/usr/bin/env bun
/**
 * Write the mirror wire contract to JSON for the screen's repository.
 *
 * Run after changing anything in the shared vocabulary — a component, a zone,
 * an overlay field, a frame type, a limit. `tests/mirror-contract.test.ts`
 * fails if the committed JSON is stale, so forgetting is caught here rather
 * than as a feature that silently does nothing on the glass.
 *
 *   bun scripts/emit-mirror-contract.ts            # rewrite the local copy
 *   bun scripts/emit-mirror-contract.ts --check    # exit 1 if it is stale
 *   bun scripts/emit-mirror-contract.ts --to DIR   # also copy into DIR
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contractDigest, mirrorContract } from "../src/contract.ts";

export const CONTRACT_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "src",
  "mirror-contract.json",
);

/** The exact bytes both repositories must hold. Trailing newline included. */
export function contractJson(): string {
  const contract = mirrorContract();
  return `${JSON.stringify({ digest: contractDigest(contract), ...contract }, null, 2)}\n`;
}

if (import.meta.main) {
  const args = new Set(Bun.argv.slice(2));
  const json = contractJson();

  if (args.has("--check")) {
    const current = await Bun.file(CONTRACT_PATH)
      .text()
      .catch(() => "");
    if (current !== json) {
      console.error("mirror-contract.json is stale — run: bun scripts/emit-mirror-contract.ts");
      process.exit(1);
    }
    console.log("mirror-contract.json is current");
  } else {
    writeFileSync(CONTRACT_PATH, json);
    console.log(`wrote ${CONTRACT_PATH}`);
  }

  // --to copies the same bytes into the screen's checkout. Deliberately a copy
  // rather than a symlink: the screen is deployed as a release tarball and has
  // to carry its own contract, and a link would resolve to nothing there.
  const argv = Bun.argv.slice(2);
  const toIndex = argv.indexOf("--to");
  if (toIndex !== -1) {
    const dir = argv[toIndex + 1];
    if (!dir) throw new Error("--to needs a directory");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "mirror-contract.json");
    writeFileSync(target, json);
    console.log(`wrote ${target}`);
  }
}
