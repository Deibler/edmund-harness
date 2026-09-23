/**
 * The ten-second pass (`com.edmund-harness.kitchen-watch`).
 *
 * For every household: fires due dinner texts, settles the site's taps that
 * need no judgement (`drain.ts`), re-renders only when something changed,
 * wakes the right member session for taps that need a person, and sends the
 * follow-up owed after a meal. Then it keeps at most one shared Apple Note in
 * step with its list.
 *
 * Deterministic answers (a meal confirmed, a line ticked) are settled here
 * because routing them through a model would only make them slower.
 */

import { existsSync } from "node:fs";
import { getAccount, listAccounts } from "../src/accounts.ts";
import { drain, needsPerson, publishQueue } from "../src/drain.ts";
import { followupDue, markAsked, mayOffer, readFollowups } from "../src/followups.ts";
import { syncDueNotes } from "../src/notesync.ts";
import { describe, due, fire } from "../src/schedules.ts";
import { loadKitchenSettings } from "../src/settings.ts";
import { shopping } from "../src/shopping.ts";
import { writeSite } from "../src/site.ts";
import { wakeForFollowup, wakeForRequests } from "../src/wake.ts";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Fire this household's due dinner texts. Each schedule fails independently. */
function fireDue(id: string): void {
  const acct = getAccount(id);
  if (!acct) return;
  for (const d of due(acct)) {
    try {
      const res = fire(id, d);
      const who = res.sent.length ? res.sent.join(", ") : "nobody";
      console.log(
        `${stamp()} ${id}: schedule ${d.id} (${describe(d, acct)}) fired -> ${res.picked ?? "nothing cookable"}, texted ${who}${res.queuedWrite ? ", asked for a written page" : ""}`,
      );
      for (const f of res.failed) {
        console.error(`${stamp()} ${id}: schedule ${d.id} could not text ${f.principal}: ${f.why}`);
      }
    } catch (e) {
      // Left unfired: the next pass inside the grace window retries it.
      console.error(`${stamp()} ${id}: schedule ${d.id} FAILED ${(e as Error).message}`);
    }
  }
}

// The same `[kitchen]` settings the MCP tools use, so both read the same kitchen.
loadKitchenSettings();

for (const { id } of listAccounts()) {
  try {
    fireDue(id);
    const res = await drain(id);
    let trouble = res.failed.length ? res.failed.join("; ") : undefined;

    for (const line of res.done) console.log(`${stamp()} ${id}: ${line}`);
    for (const line of res.failed) console.error(`${stamp()} ${id}: FAILED ${line}`);

    // Re-render only when something was decided.
    if (res.done.length) {
      const acct = getAccount(id);
      const dir = acct?.site?.artifact;
      if (acct && dir && existsSync(dir)) {
        // Caught here so a failed render is still published as trouble.
        try {
          const { pages } = writeSite(id, acct, dir);
          console.log(`${stamp()} ${id}: re-rendered (${pages} recipe pages)`);
        } catch (e) {
          trouble = [trouble, `render: ${(e as Error).message}`].filter(Boolean).join("; ");
          console.error(`${stamp()} ${id}: FAILED render ${(e as Error).message}`);
        }
      }
    }

    // Taps that need a person wake the member who made them. Filtered by the
    // same predicate as `stillWaiting`, and rate-limited inside `wake`.
    const acct = getAccount(id);
    if (acct) {
      try {
        const dir = acct.site?.artifact ?? "";
        const w = wakeForRequests(
          id,
          acct,
          res.left.filter((r) => needsPerson(id, dir, r)),
        );
        for (const x of w.woke)
          console.log(
            `${stamp()} ${id}: woke ${x.session} for ${x.keys.length} request(s), job ${x.job}`,
          );
        for (const h of w.held)
          if (h.why !== "recent")
            console.log(`${stamp()} ${id}: not waking for ${h.key} (${h.why})`);
      } catch (e) {
        trouble = [trouble, `wake: ${(e as Error).message}`].filter(Boolean).join("; ");
        console.error(`${stamp()} ${id}: FAILED wake ${(e as Error).message}`);
      }
    }

    // A meal sent yesterday gets one short follow-up in the chat it was planned
    // in, carrying any stock suspicions and recent run-outs worth offering.
    if (acct) {
      try {
        const due = followupDue(id);
        if (due) {
          const state = readFollowups(id);
          const offers = shopping(id)
            .suggestions.filter((x) => x.kind === "restock" && mayOffer(state, x.item))
            .slice(0, 4);
          const w = wakeForFollowup(
            id,
            acct,
            due,
            offers.map((o) => o.name),
          );
          if (w.woke.length || w.held.some((h) => h.why !== "recent")) {
            markAsked(id, {
              plan: due.plan.id,
              suspects: due.suspects.map((x) => x.id),
              offered: offers.map((o) => o.item),
            });
          }
          for (const x of w.woke)
            console.log(
              `${stamp()} ${id}: follow-up on "${due.plan.meal}" to ${x.session}, job ${x.job}`,
            );
        }
      } catch (e) {
        trouble = [trouble, `follow-up: ${(e as Error).message}`].filter(Boolean).join("; ");
        console.error(`${stamp()} ${id}: FAILED follow-up ${(e as Error).message}`);
      }
    }

    // Written last: the queue's timestamp is the liveness signal, so a pass
    // that failed early must not write it.
    publishQueue(id, trouble);
  } catch (e) {
    // One household's failure must not stop the others.
    console.error(`${stamp()} ${id}: FAILED ${(e as Error).message}`);
  }
}

/*
 * Keep the shared Apple Notes in step with the lists. This drives a browser, so
 * it runs after the household loop and handles at most one note per pass;
 * `syncDueNotes` decides with a pure fold whether any note needs opening.
 */
try {
  for (const r of await syncDueNotes()) {
    if (!r.ok) {
      console.error(`${stamp()} ${r.account}: FAILED note sync ${r.error}`);
      continue;
    }
    console.log(
      `${stamp()} ${r.account}: note "${r.title}" ${r.wrote ? "rewritten" : "already current"} (${r.lines} lines, via ${r.via}${r.how ? `, ${r.how}` : ""})${r.ticked.length ? `, ${r.ticked.length} ticked off` : ""}${r.adopted.length ? `, adopted ${r.adopted.join(", ")}` : ""}${r.invited.length ? `, invited ${r.invited.join(", ")}` : ""}`,
    );
  }
} catch (e) {
  console.error(`${stamp()} FAILED note sync ${(e as Error).message}`);
}
