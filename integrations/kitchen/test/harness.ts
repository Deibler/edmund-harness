/**
 * Make these files real tests.
 *
 * They were written as scripts: a local `check()` that counted failures and a
 * `process.exit()` at the bottom. Two things followed, both bad. A failing
 * check printed "FAIL" and the runner still reported success, because nothing
 * had ever registered a test for it to fail. And `process.exit(0)` at the top
 * level of a file under `bun test` ends the WHOLE run — so `bun test` at the
 * repo root stopped at whichever kitchen file finished first and printed "all
 * passed" having silently skipped everything after it.
 *
 * The ergonomics were the good part, so they are kept: a check reads as a
 * sentence about the kitchen rather than an assertion about a variable. The
 * condition is evaluated eagerly, at the point the file computes it, and the
 * boolean is carried into a real registered test.
 */

import { expect, test } from "bun:test";

export function check(label: string, cond: boolean): void {
  test(label, () => {
    expect(cond).toBe(true);
  });
}

/** Kept so the files still read as sections. Bun prints the file name itself. */
export function section(title: string): void {
  void title;
}
