import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsRow } from "../src/recovery/sweeper.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";

const DM = "imessage:dm:+15551234567" as SessionKey;
const TRADING = "trading:dm:+15551234567" as SessionKey;
const GROUP = "imessage:group:any;+;chat-1" as SessionKey;
const ORCH_GROUP = "orch:desmond:group:any;+;chat-1" as SessionKey;

let dir: string;
let state: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-owns-row-"));
  state = new StateStore(dir);
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

// One predicate gates both the recovery sweeper (which runs a recovery turn
// over the rows) and the fallback notice (which tells the chat we're stuck).
describe("ownsRow", () => {
  test("a recorded owner decides, for every session kind", () => {
    state.recordRouting(1, GROUP);
    expect(ownsRow(state, GROUP, 1)).toBe(true);
    expect(ownsRow(state, ORCH_GROUP, 1)).toBe(false);
    state.recordRouting(2, TRADING);
    expect(ownsRow(state, TRADING, 2)).toBe(true);
    expect(ownsRow(state, DM, 2)).toBe(false);
  });

  test("group: no routing record means the gate dropped it, so nobody owes it", () => {
    // Every accepted group row is recorded (live routeAccepted, catch-up,
    // and the address check, which calls routeAccepted). An unrecorded one
    // is the group talking among themselves.
    expect(ownsRow(state, GROUP, 3)).toBe(false);
    expect(ownsRow(state, ORCH_GROUP, 3)).toBe(false);
  });

  test("DM: no record still belongs to the main persona, never to trading", () => {
    expect(ownsRow(state, DM, 4)).toBe(true);
    expect(ownsRow(state, TRADING, 4)).toBe(false);
  });
});
