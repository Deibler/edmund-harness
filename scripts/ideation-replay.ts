#!/usr/bin/env bun
/**
 * Run the ideator for one person, as of a date, without building or sending
 * anything: the check that its picks are right before it is trusted.
 *
 *   bun scripts/ideation-replay.ts <handle> [--as-of YYYY-MM-DD]
 *
 * Prints every thread it found with the separate days chat.db confirms, which
 * threads were excluded and why, the candidates the gates turned down, and the
 * pick. Records no spend, no run, no threads. The model call itself is paid.
 */

import { loadConfig } from "../src/config/config.ts";
import { runIdeator } from "../src/ideation/ideator.ts";
import { IdeationStore } from "../src/ideation/store.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

const args = process.argv.slice(2);
const handle = args.find((a) => !a.startsWith("--"));
const asOfFlag = args.indexOf("--as-of");
const asOfDay = asOfFlag >= 0 ? args[asOfFlag + 1] : undefined;
if (!handle || (asOfFlag >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDay ?? ""))) {
  console.error("usage: bun scripts/ideation-replay.ts <handle> [--as-of YYYY-MM-DD]");
  process.exit(2);
}
// The end of that day, Eastern: everything they said that day counts.
const asOfMs = asOfDay ? Date.parse(`${asOfDay}T23:59:00-05:00`) : Date.now();

const config = loadConfig();
const chatDb = new ChatDb(config.paths.chat_db);
const contacts = new ContactBook(config.contacts, new AddressBook());
const store = new IdeationStore(config.paths.data_dir);
const sessionKey = `imessage:dm:${handle}`;

const t0 = Date.now();
const r = await runIdeator({ config, chatDb, contacts, store }, sessionKey, {
  asOfMs,
  dryRun: true,
});
const secs = ((Date.now() - t0) / 1000).toFixed(0);

console.log(
  `# ${handle} as of ${asOfDay ?? "now"}: ${r.outcome} ($${r.costUsd?.toFixed(3) ?? "?"}, ${secs}s)`,
);
console.log(`reason: ${r.reason}\n`);
if (r.raw) console.log(`the model's last answer, unusable:\n${r.raw}\n`);
console.log("threads (days confirmed in chat.db):");
for (const t of [...r.threads].sort((a, b) => b.days.length - a.days.length)) {
  const flag = t.excluded ? `EXCLUDED (${t.excluded})` : t.recurs ? "recurs" : "does not recur";
  console.log(
    `  [${t.days.length}d] ${t.label} — ${t.category}, ${flag}; ${t.accepted.length} cited ok, ${t.rejected} rejected`,
  );
  if (t.days.length > 0) console.log(`        ${t.days.join(" ")}`);
}
if (r.turnedDown.length > 0) {
  console.log("\nturned down:");
  for (const d of r.turnedDown) console.log(`  "${d.title}" (${d.thread}): ${d.why}`);
}
if (r.pick) {
  console.log(`\nPICK: "${r.pick.title}" — thread "${r.pick.thread}", ${r.pick.days.length} days`);
  console.log(`pitch: ${r.pick.pitch}`);
  console.log(`why: ${r.pick.why}`);
  console.log(`brief:\n${r.pick.brief}`);
}
store.close();
