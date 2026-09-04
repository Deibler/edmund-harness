#!/usr/bin/env bun
/**
 * Put a scene on the glass without talking to it.
 *
 * UI work on the mirror has one hard problem: the only way content normally
 * arrives is a voice turn, which is slow, non-deterministic, and impossible to
 * repeat exactly. So every judgement about the design ("is that gap right?",
 * "does a six-item list overflow?") costs a conversation, and no two runs are
 * comparable.
 *
 * This writes straight into MirrorStore through the SAME validation and the
 * SAME store call an MCP tool would use — `UpdateInput` + `toContentInput` —
 * so a scene that renders here is a scene the model could actually have
 * produced. The running daemon's bridge drains the outbox every 300 ms and
 * pushes it, so nothing here has to know about the wire.
 *
 * Deliberately NOT a test fixture format: scenes are the real props, which
 * means a scene file that stops validating is telling you the schema moved.
 *
 *   bun integrations/mirror/scripts/scene.ts list
 *   bun integrations/mirror/scripts/scene.ts apply scenes/restaurants.json
 *   bun integrations/mirror/scripts/scene.ts remove calendar quote
 *   bun integrations/mirror/scripts/scene.ts clear
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../../src/config/config.ts";
import { mirrorConfig } from "../config.ts";
import { summarizeContent } from "../src/protocol.ts";
import { MirrorStore } from "../src/store.ts";
import { UpdateInput, toContentInput } from "../tools.ts";

const DATA_DIR = process.env.EDMUND_DATA_DIR ?? "./data";

/**
 * The daemon writes to the same database, and its outbox drain runs every
 * 300 ms — so a scene applied at the wrong moment loses a coin flip and dies
 * with SQLITE_BUSY. That is fine for a human retrying by hand and useless in
 * an unattended loop, where the failure looks like "the scene did not render"
 * and sends you looking at the renderer.
 *
 * Retry the whole operation rather than the statement: these are transactions,
 * and half of one is not something to resume.
 */
function withStore<T>(fn: (store: MirrorStore) => T): T {
  const deadline = Date.now() + 5_000;
  for (let attempt = 0; ; attempt++) {
    const store = new MirrorStore(DATA_DIR);
    try {
      return fn(store);
    } catch (error) {
      const busy = (error as { code?: string })?.code === "SQLITE_BUSY";
      if (!busy || Date.now() > deadline) throw error;
      Bun.sleepSync(Math.min(400, 25 * 2 ** attempt));
    } finally {
      store.close();
    }
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function apply(paths: string[]): void {
  const config = loadConfig();
  const ttl = mirrorConfig(config).default_ttl_seconds;

  const items: unknown[] = [];
  for (const path of paths) {
    const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
    // A scene is one item or a list of them; both spellings are common enough
    // in a scratch file that rejecting either is just friction.
    if (Array.isArray(raw)) items.push(...raw);
    else items.push(raw);
  }

  // Validate EVERY item before writing ANY of them. A half-applied scene is
  // worse than a rejected one: you screenshot it, judge the design off it, and
  // the thing you were actually looking at was three of five widgets.
  const parsed = items.map((item, index) => {
    const result = UpdateInput.safeParse(item);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      die(`scene item ${index} is not something the model could send — ${issues}`);
    }
    return result.data;
  });

  // One withStore per item, not one around the loop. The retry re-runs its
  // whole callback, so a BUSY on the second item re-applied the first — upsert
  // is idempotent so nothing was wrong, but the output said "applied" twice
  // for one widget and burned a revision, which is exactly the kind of noise
  // that sends you looking for a bug in the store.
  for (const item of parsed) {
    const content = withStore((store) =>
      store.upsertContent(toContentInput(item, ttl), "scene.apply"),
    );
    console.log(`applied ${summarizeContent(content)}`);
  }
}

function list(): void {
  const snapshot = withStore((store) => store.snapshot());
  console.log(`revision=${snapshot.revision} page=${snapshot.page} rotation=${snapshot.rotation}`);
  for (const item of snapshot.contents) console.log(summarizeContent(item));
  if (snapshot.contents.length === 0) console.log("(no content)");
}

function remove(ids: string[]): void {
  // Per id, for the same reason apply() is per item: a retry re-runs the whole
  // callback, and a second removal of something already gone reports "not
  // found" for a thing that WAS found a moment earlier.
  for (const id of ids) {
    const gone = withStore((store) => store.removeContent(id, "scene.remove"));
    console.log(gone ? `removed ${id}` : `${id} not found`);
  }
}

function clear(): void {
  // Protected baseline fixtures (the clock) survive — resetToBaseline is the
  // store's own definition of "known good", so a scene run can never strand
  // the glass in a state a reboot would not fix.
  const result = withStore((store) => store.resetToBaseline("scene.clear"));
  console.log(`reset to baseline at revision ${result.revision}; removed ${result.removed.length}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "apply":
    if (rest.length === 0) die("apply needs at least one scene file");
    apply(rest);
    break;
  case "list":
    list();
    break;
  case "remove":
    if (rest.length === 0) die("remove needs at least one content id");
    remove(rest);
    break;
  case "clear":
    clear();
    break;
  default:
    die("usage: scene.ts <apply FILE… | list | remove ID… | clear>");
}
