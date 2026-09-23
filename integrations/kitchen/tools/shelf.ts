/**
 * The shelf check: reconcile the ledger against the real shelves, from photos
 * or a question-and-answer pass. Nothing is written until `apply`.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import {
  type Verdict,
  answer as answerCheck,
  applySession,
  openSession,
  progress,
  readSessions,
  startSession,
} from "../src/reconcile.ts";
import { proposeShelves, shelfBrief } from "../src/shelfread.ts";
import { amount, live } from "../src/store.ts";
import { Acct, text, withAccount } from "./shared.ts";

export function shelfTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_check",
      description:
        "Reconcile the ledger against the actual shelves. Three ways in, one pass: " +
        "`photos` hands you the ledger as a checklist to read pictures of a fridge or " +
        "cabinet against, and `propose` turns what YOU saw into a PROPOSED diff; `start` " +
        "opens a text-driven pass over the items worth asking about; `answer` records " +
        "verdicts as they come. Nothing reaches the ledger until `apply`. Every verdict " +
        "is stamped with who looked, so a pass Jordan did reads as his. Use this whenever " +
        "somebody sends a kitchen photo or says the counts are off.",
      inputSchema: z.object({
        account: Acct,
        action: z.enum(["photos", "propose", "start", "answer", "apply", "status"]),
        by: z
          .string()
          .nullish()
          .describe(
            "Principal of whoever actually looked. Required for propose/start; " +
              "a pass with no name attached is worth much less than one with.",
          ),
        files: z.array(z.string()).optional().describe("photos: absolute paths to the images."),
        where: z.string().nullish().describe("photos/propose: 'fridge', 'the spice drawer'."),
        seen: z
          .array(
            z.object({
              item: z.string().describe("A ledger slug from the checklist."),
              verdict: z.enum(["have", "gone", "amount"]),
              qty: z.number().nullish(),
              because: z.string().nullish().describe("What in the photo says so."),
            }),
          )
          .optional()
          .describe("propose: only what the photos actually show. Not visible is not gone."),
        unknown: z
          .array(z.string())
          .optional()
          .describe("propose: visible but untracked, in plain words. Suggestions, never added."),
        note: z.string().nullish().describe("propose: what the photos could not show."),
        session: z
          .string()
          .nullish()
          .describe("answer/apply: which pass. Defaults to the open one."),
        answers: z
          .array(
            z.object({
              item: z.string(),
              verdict: z.enum(["have", "gone", "amount"]),
              qty: z.number().nullish(),
            }),
          )
          .optional()
          .describe("answer: one entry per item settled."),
        limit: z.number().optional().describe("start/status: how many to show. Default 12."),
      }),
      handler: async (a) =>
        withAccount(ctx, a.account, async (id: string) => {
          const items = Object.fromEntries(live(id).map((i) => [i.id, i]));
          const show = (ids: string[]) =>
            ids
              .map((x) => {
                const it = items[x];
                return it
                  ? `  ${it.id}  ${it.name} — ledger says ${amount(it)} in the ${it.loc}`
                  : `  ${x}`;
              })
              .join("\n");

          if (a.action === "photos") {
            if (!a.files?.length) return text("Give me the image paths.", true);
            const missing = a.files.filter((f: string) => !existsSync(f));
            if (missing.length) return text(`Cannot read: ${missing.join(", ")}`, true);
            return text(
              `${shelfBrief(id, a.files, a.where)}\n\nPass by:${JSON.stringify(a.by ?? "")} through to propose so the pass is stamped with who looked.`,
            );
          }

          if (a.action === "propose") {
            if (!a.seen?.length && !a.unknown?.length)
              return text('Nothing seen. Look at the photos first (action:"photos").', true);
            const read = proposeShelves(id, a.seen ?? [], a.unknown ?? [], a.note ?? "");
            const ids = Object.keys(read.proposed);
            if (!ids.length) {
              return text(
                `Nothing in those photos lines up with anything the ledger tracks.${read.unknown.length ? `\nVisible but untracked: ${read.unknown.join(", ")}` : ""}`,
              );
            }
            const s = startSession(id, {
              by: a.by ?? null,
              source: "photos",
              only: ids,
              proposed: read.proposed,
            });
            const line = (x: string) => {
              const v = read.proposed[x]!;
              const it = items[x];
              const said =
                v.kind === "have"
                  ? "still there"
                  : v.kind === "gone"
                    ? "NOT there"
                    : `${v.qty}${it?.unit ? ` ${it.unit}` : ""} rather than ${amount(it!)}`;
              return `  ${x}: ${said}${read.because[x] ? ` — ${read.because[x]}` : ""}`;
            };
            return text(
              `Proposed from the photos${a.where ? ` of the ${a.where}` : ""}. Session ${s.id}, PROPOSED ONLY, nothing written.\n\n${ids.map(line).join("\n")}${
                read.unknown.length ? `\n\nVisible but not tracked: ${read.unknown.join(", ")}` : ""
              }${read.note ? `\n\nWhat the photos could not show: ${read.note}` : ""}\n\nConfirm with the human before applying. Correct anything wrong with action:"answer", then action:"apply".`,
            );
          }

          if (a.action === "start") {
            const s = startSession(id, { by: a.by ?? null });
            if (!s.queue.length) {
              return text(
                "Nothing is worth asking about: everything has been seen or logged " +
                  "in the last couple of days.",
              );
            }
            const n = a.limit ?? 12;
            return text(
              `Pass ${s.id} open${a.by ? ` for ${a.by}` : ""}, ${s.queue.length} worth checking, most informative first.\n\n${show(s.queue.slice(0, n))}\n\nAsk about these, then record with action:"answer". Nothing is written until apply.`,
            );
          }

          const s = a.session
            ? (readSessions(id).find((x) => x.id === a.session) ?? null)
            : openSession(id, a.by ?? undefined);
          if (!s) return text('No open pass. Start one with action:"start" or "photos".', true);

          if (a.action === "status") {
            const p = progress(s);
            return text(
              `Pass ${s.id}${s.by ? ` (${s.by})` : ""}, from ${s.source}. ${p.done} answered, ${p.left} left${s.applied ? `, applied ${s.applied}` : ""}.${p.left ? `\n\n${show(s.queue.slice(0, a.limit ?? 12))}` : ""}`,
            );
          }

          if (a.action === "answer") {
            if (!a.answers?.length) return text("No answers given.", true);
            let n = 0;
            for (const ans of a.answers) {
              if (!items[ans.item]) continue;
              const v: Verdict =
                ans.verdict === "gone"
                  ? { kind: "gone" }
                  : ans.verdict === "amount" && typeof ans.qty === "number"
                    ? { kind: "amount", qty: ans.qty, unit: items[ans.item]!.unit }
                    : { kind: "have" };
              if (answerCheck(id, s.id, ans.item, v, s.by)) n++;
            }
            const p = progress(s);
            return text(
              `Recorded ${n}. ${p.done} answered, ${p.left} left. Still nothing in the ledger; call action:"apply" when the human is done.`,
            );
          }

          const res = applySession(id, s.id);
          if (!res) return text("Nothing to apply on that pass.", true);
          return text(
            `Written as batch ${res.batch}, undoable in one go.\n` +
              `  confirmed as listed: ${res.confirmed}\n` +
              `  taken off the shelves: ${res.removed.map((r) => r.name).join(", ") || "none"}\n` +
              `  recounted: ${res.corrected.map((c) => `${c.name} ${c.from} -> ${c.to}`).join(", ") || "none"}`,
          );
        }),
    },
  ];
}
