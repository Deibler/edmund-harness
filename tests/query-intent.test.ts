import { expect, test } from "bun:test";

import { hasRetrievableIntent } from "../src/memory/query-intent.ts";

// The gate exists because semantic search always returns its quota. Measured on
// the live index, "Edmund hi" scores 0.761 against the corpus while "SpaceX
// stock tracker tunnel" — a query about something genuinely in there — reaches
// 0.759. No score floor separates those, so the decision has to be made before
// scoring: a message with no subject has nothing to look up.

const NAMES = ["edmund", "ed", "eddie", "eddy"];

test("the message that caused this is declined", () => {
  // A bare greeting pulled 28 items from one to four months earlier, and the
  // model opened with a status report on a six-week-old stock tracker.
  expect(hasRetrievableIntent("Edmund hi", NAMES)).toBe(false);
});

test("greetings and acknowledgements have nothing to look up", () => {
  for (const empty of [
    "hi",
    "hey",
    "Hello!",
    "hey there",
    "yo",
    "Edmund hey",
    "ed hi",
    "thanks",
    "Thanks Edmund",
    "thank you",
    "ok",
    "okay cool",
    "yeah",
    "nah",
    "lol",
    "haha nice",
    "good morning",
    "gn",
    "sure, thanks",
    "hi again",
    "hey edmund, thanks!",
  ]) {
    expect(hasRetrievableIntent(empty, NAMES), empty).toBe(false);
  }
});

test("anything with a subject still searches", () => {
  for (const real of [
    "Edmund can you turn the SpaceX stock tracker back on",
    "what's the radar look like",
    "tractor steering is stiff",
    "SPCX price?",
    "did the cron fire",
    // Terse but about something.
    "weather?",
    "kdix",
    // A number is a subject.
    "11 shares",
    "$174",
    // Emoji and punctuation cannot pad an empty message into a real one, but
    // they must not block a real one either.
    "thanks! but why is the tracker up?",
  ]) {
    expect(hasRetrievableIntent(real, NAMES), real).toBe(true);
  }
});

test("a long message always searches, whatever it opens with", () => {
  // The reply that prompted this was itself a long message beginning with
  // "Thanks Edmund" — it must not be mistaken for a bare acknowledgement.
  const long =
    "Thanks Edmund but all I said was hi and questioned why you were talking about the tracker";
  expect(long.length).toBeGreaterThan(60);
  expect(hasRetrievableIntent(long, NAMES)).toBe(true);
});

test("empty and near-empty input is declined without throwing", () => {
  for (const nothing of ["", " ", "\n", "!", "?!", "👍", "..."]) {
    expect(hasRetrievableIntent(nothing, NAMES), JSON.stringify(nothing)).toBe(false);
  }
});

test("names are only stripped when they are ours", () => {
  // "douglas" is not one of our trigger words, so it is a subject.
  expect(hasRetrievableIntent("hi douglas", NAMES)).toBe(true);
  expect(hasRetrievableIntent("hi edmund", NAMES)).toBe(false);
});

test("it works with no names configured", () => {
  expect(hasRetrievableIntent("hi", [])).toBe(false);
  expect(hasRetrievableIntent("radar please", [])).toBe(true);
});
