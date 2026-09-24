#!/usr/bin/env bun
/**
 * Replay the missed-name check over hand-labelled group messages and print
 * how each threshold would have done. Run it after changing the questions,
 * the state, or the model: Jev's scores move with wording, so a threshold is
 * only valid for the wording it was measured on.
 *
 *   bun scripts/addressing-calibrate.ts [labels.json]
 *
 * Labels default to data/addressing/labels.json:
 *   {"labels": [{"row": <chat.db ROWID>, "label": "yes" | "yes-ish" | "ambiguous" | "no"}]}
 * Each row is rebuilt through the live watcher's parser and checked as of its
 * own moment (history before it, the assistant's last message before it).
 * Results go to data/addressing/calibration-<version>.json. Each checked row
 * costs one Jev call, roughly $0.00005.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import {
  ADDRESS_QUESTIONS_VERSION,
  type CandidateReason,
  addressQuestions,
  addressState,
  assistantName,
  candidateReason,
} from "../src/gating/address-check.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { readMessage } from "../src/imessage/watcher.ts";
import { askJev } from "../src/jev/client.ts";

type Label = "yes" | "yes-ish" | "ambiguous" | "no";
type Result = {
  row: number;
  label: Label;
  reason: CandidateReason | null;
  addressed?: number;
  wants_reply?: number;
  error?: string;
};

const config = loadConfig();
const labelsPath = process.argv[2] ?? join(config.paths.data_dir, "addressing", "labels.json");
const labels: { row: number; label: Label }[] = JSON.parse(readFileSync(labelsPath, "utf8")).labels;
const chatDb = new ChatDb(config.paths.chat_db);
const questions = addressQuestions(assistantName(config));
const model = config.group_addressing.model;

const results: Result[] = [];
await Promise.all(
  labels.map(async ({ row, label }) => {
    const msg = readMessage(chatDb, row);
    const reason = msg ? candidateReason(msg, chatDb, config) : null;
    if (!msg || !reason) return results.push({ row, label, reason: null });
    try {
      const res = await askJev(addressState(msg, chatDb, config), questions, {
        apiKey: config.keys.openrouter,
        model,
      });
      results.push({
        row,
        label,
        reason,
        addressed: Number(res.answers.addressed),
        wants_reply: Number(res.answers.wants_reply),
      });
    } catch (err) {
      results.push({ row, label, reason, error: (err as Error).message });
    }
  }),
);

const out = join(
  config.paths.data_dir,
  "addressing",
  `calibration-${ADDRESS_QUESTIONS_VERSION}.json`,
);
writeFileSync(out, JSON.stringify({ version: ADDRESS_QUESTIONS_VERSION, model, results }, null, 1));

const of = (l: Label) => results.filter((r) => r.label === l);
const errors = results.filter((r) => r.error).length;
console.log(
  `${results.length} labelled rows, ${results.filter((r) => r.reason).length} candidates, ${errors} without an answer`,
);
console.log(
  `yes: ${of("yes").length}, not nominated: ${of("yes").filter((r) => !r.reason).length}`,
);
console.log(`\nreply  addressed | yes woken | yes-ish woken | no woken | ambiguous woken`);
for (const reply of [0.4, 0.5, 0.6, 0.7]) {
  for (const addressed of [0.6, 0.7, 0.8]) {
    const woken = (r: Result) =>
      r.reason !== null &&
      r.wants_reply !== undefined &&
      (r.wants_reply >= reply || (r.reason !== "after-assistant" && r.addressed! >= addressed));
    const n = (l: Label) => `${of(l).filter(woken).length}/${of(l).length}`;
    console.log(
      `${reply}   ${addressed}      | ${n("yes")}  | ${n("yes-ish")}  | ${n("no")}  | ${n("ambiguous")}`,
    );
  }
}
console.log(`\nwritten to ${out}`);
