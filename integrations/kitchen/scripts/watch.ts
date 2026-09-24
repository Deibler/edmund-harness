/**
 * The ten-second pass (`com.edmund-harness.kitchen-watch`).
 *
 * For every household: fires due dinner texts, settles the site's taps that
 * need no judgement (`drain.ts`), re-renders only when something changed,
 * wakes the right member session for taps that need a person, and sends the
 * follow-up owed after a meal, and wakes the household's session to bring its
 * shared Apple Note up to date on screen once the list has changed.
 *
 * Deterministic answers (a meal confirmed, a line ticked) are settled here
 * because routing them through a model would only make them slower.
 */

import { existsSync } from "node:fs";
import { getAccount, listAccounts } from "../src/accounts.ts";
import { drain, needsPerson, publishQueue } from "../src/drain.ts";
import { followupDue, markAsked, mayOffer, readFollowups } from "../src/followups.ts";
import { noteStep, screenLocked } from "../src/notewatch.ts";
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
const config = loadKitchenSettings();

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

    // The shared note has no writer but Edmund on screen. Once the list has
    // changed and settled, or somebody asked from the site, the household's
    // session is woken to bring the note up to date, unless it could not do
    // it now (no Notes for that chat, or a locked Mac); see `noteStep`.
    if (acct) {
      try {
        for (const line of await noteStep(id, acct, config, { locked: screenLocked }))
          console.log(`${stamp()} ${id}: ${line}`);
      } catch (e) {
        trouble = [trouble, `note: ${(e as Error).message}`].filter(Boolean).join("; ");
        console.error(`${stamp()} ${id}: FAILED note check ${(e as Error).message}`);
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
