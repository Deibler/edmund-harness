#!/usr/bin/env bun
/**
 * Publish a page built for an ideation, once it passes the page check.
 *
 *   bun scripts/ideation-publish.ts <id> <path to dist/index.html>
 *   bun scripts/ideation-publish.ts --check <path>      (check only, no id)
 *
 * The builder runs this last. On a problem it prints each one and exits 1:
 * fix them and run it again. On success it prints the page's permanent link.
 */

import { loadConfig } from "../src/config/config.ts";
import { PageChecker } from "../src/ideation/page-check.ts";
import { publishIdeation } from "../src/ideation/publish.ts";
import { IdeationStore } from "../src/ideation/store.ts";

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const [id, path] = checkOnly ? ["", args[1]] : [args[0], args[1]];
if (!path || (!checkOnly && !id)) {
  console.error("usage: bun scripts/ideation-publish.ts <id> <path to dist/index.html>");
  console.error("       bun scripts/ideation-publish.ts --check <path>");
  process.exit(2);
}

const checker = await PageChecker.launch();
try {
  if (checkOnly) {
    const r = await checker.check(await Bun.file(path).text(), { allScreens: true });
    report(r.ok, r.problems);
    // One picture per phone screen, top to bottom, so everything below the
    // fold can be judged too. The first is also what link previews show.
    for (const [i, shot] of r.screens.entries()) {
      const file = `${path}.screen-${i + 1}.jpg`;
      await Bun.write(file, shot);
      console.log(`screen ${i + 1}: ${file}`);
    }
    if (r.pageHeight) {
      const total = Math.ceil(r.pageHeight / 844);
      console.log(
        `the page is ${r.pageHeight}px tall at 390px wide: ${total} phone screen${total === 1 ? "" : "s"}${total > r.screens.length ? `, of which the first ${r.screens.length} are pictured` : ""}.`,
      );
    }
    process.exitCode = r.ok ? 0 : 1;
  } else {
    const config = loadConfig();
    const store = new IdeationStore(config.paths.data_dir);
    const r = await publishIdeation(
      {
        store,
        dataDir: config.paths.data_dir,
        origin: config.shelf.origin,
        check: (html) => checker.check(html),
      },
      id as string,
      path,
    );
    store.close();
    if (r.ok) console.log(`published: ${r.url ?? "(no [shelf] origin set; served locally only)"}`);
    else report(false, r.problems);
    process.exitCode = r.ok ? 0 : 1;
  }
} finally {
  await checker.close();
}

function report(ok: boolean, problems: string[]): void {
  if (ok) {
    console.log("the page passed the check.");
    return;
  }
  console.log(
    `the page was not published. Fix ${problems.length === 1 ? "this" : "these"} and run again:`,
  );
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}
