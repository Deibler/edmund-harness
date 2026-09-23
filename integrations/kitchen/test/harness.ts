/**
 * `check()` and `section()` for the script-style kitchen tests.
 *
 * Each check registers a real `bun:test` test, so a failing check fails the
 * run. The condition is evaluated eagerly where the file computes it; the
 * result is carried into the registered test. Files must never call
 * `process.exit()`, which would end the whole `bun test` run.
 */

import { expect, test } from "bun:test";

export function check(label: string, cond: boolean): void {
  test(label, () => {
    expect(cond).toBe(true);
  });
}

/** A readable section marker; bun already prints the file name. */
export function section(title: string): void {
  void title;
}
