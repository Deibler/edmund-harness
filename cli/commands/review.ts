/**
 * `edmund review [--days 7] [--sample 40]` — write this week's review sheet:
 * reply times, unanswered DMs, every correction people sent, leaked control
 * words, background failures, and a sample of real exchanges to mark pass or
 * fail. Read-only; the sheet goes to data/reviews/<date>.md.
 */

import { loadConfig } from "../../src/config/config.ts";
import { buildWeeklyReview, writeWeeklyReview } from "../../src/evals/weekly-review.ts";
import { ChatDb } from "../../src/imessage/db.ts";
import { AddressBook } from "../../src/sessions/address-book.ts";
import { ContactBook } from "../../src/sessions/contacts.ts";
import { chatIdFromKey, isGroupSession } from "../../src/sessions/key.ts";
import type { Parsed } from "../args.ts";
import { getString } from "../args.ts";
import { info, ok, print } from "../ui.ts";

export async function reviewCommand(p: Parsed): Promise<void> {
  const days = Number(getString(p, "days") ?? 7) || 7;
  const sample = Number(getString(p, "sample") ?? 40) || 40;
  const config = loadConfig();
  const chatDb = new ChatDb(config.paths.chat_db);
  let contacts: ContactBook | null = null;
  try {
    contacts = new ContactBook(config.contacts, new AddressBook());
  } catch {
    contacts = null;
  }
  const label = (key: string) => {
    if (isGroupSession(key)) return key.slice(0, 18);
    const handle = chatIdFromKey(key);
    return contacts?.label(handle) ?? handle;
  };
  const body = buildWeeklyReview({
    chatDb,
    dataDir: config.paths.data_dir,
    days,
    sample,
    label,
  });
  const path = writeWeeklyReview(config.paths.data_dir, body);
  const numbers = body.split("## Corrections")[0] ?? "";
  print(numbers.trim());
  ok(`review sheet written: ${path}`);
  info("read the sample, mark pass/fail, and note the first failure in each");
}
