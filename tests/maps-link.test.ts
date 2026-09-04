import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MapLinkError,
  appleMapsLink,
  hasMapsLink,
  isBareLink,
  looksLikeStreetAddress,
} from "../src/imessage/maps-link.ts";

describe("apple maps links", () => {
  test("a name plus an address labels the card with the place", () => {
    const url = appleMapsLink({
      name: "Sabrina's Cafe",
      address: "910 N 27th St, Philadelphia, PA",
    });
    // `address` shows the location without searching; `q` becomes the label.
    expect(url).toContain("address=910%20N%2027th%20St%2C%20Philadelphia%2C%20PA");
    expect(url).toContain("q=Sabrina%27s%20Cafe");
  });

  test("coordinates win over an address — a street name can geocode wrong", () => {
    const url = appleMapsLink({
      name: "In Riva",
      address: "4116 Ridge Ave",
      latitude: 40.0129,
      longitude: -75.2019,
    });
    expect(url).toContain("ll=40.0129%2C-75.2019");
    expect(url).not.toContain("address=");
    expect(url).toContain("q=In%20Riva");
  });

  test("a name alone falls back to a search, which is the right behaviour", () => {
    expect(appleMapsLink({ name: "Cosmic Cafe Philadelphia" })).toBe(
      "https://maps.apple.com/?q=Cosmic%20Cafe%20Philadelphia",
    );
  });

  test("spaces encode as %20, matching what Apple's own share sheet emits", () => {
    expect(appleMapsLink({ address: "1 Infinite Loop" })).not.toContain("+");
  });

  test("naming nothing is an error, not a link to the user's own location", () => {
    expect(() => appleMapsLink({})).toThrow(MapLinkError);
    expect(() => appleMapsLink({ name: "   " })).toThrow(MapLinkError);
  });

  test("out-of-range coordinates are refused", () => {
    expect(() => appleMapsLink({ latitude: 91, longitude: 0 })).toThrow(/out of range/);
  });

  test("a preview card needs the URL alone — trailing text kills it", () => {
    expect(isBareLink("https://maps.apple.com/?q=x")).toBeTrue();
    expect(isBareLink("  https://maps.apple.com/?q=x  ")).toBeTrue();
    expect(isBareLink("here you go https://maps.apple.com/?q=x")).toBeFalse();
    expect(isBareLink("https://maps.apple.com/?q=x — big portions")).toBeFalse();
  });
});

describe("addresses default to a card, and we can tell whether they did", () => {
  test("detects a street address written as prose", () => {
    expect(looksLikeStreetAddress("Sabrina's at 910 N 27th St, huge portions")).toBeTrue();
    expect(looksLikeStreetAddress("meet me at 4116 Ridge Ave")).toBeTrue();
    expect(looksLikeStreetAddress("1600 Pennsylvania Avenue")).toBeTrue();
  });

  test("does not fire on prose that merely mentions a place", () => {
    // A bare place name is not an address and a card is optional there — a
    // false positive would put noise in the log for a normal sentence.
    expect(looksLikeStreetAddress("grab food at Cosmic after the run")).toBeFalse();
    expect(looksLikeStreetAddress("I ran 8 miles at 9:20 pace")).toBeFalse();
    expect(looksLikeStreetAddress("see you in 5 minutes")).toBeFalse();
  });

  test("recognises a message that already carries a card", () => {
    expect(hasMapsLink("https://maps.apple.com/?q=Sabrina%27s")).toBeTrue();
    expect(hasMapsLink("910 N 27th St")).toBeFalse();
  });

  test("the prompt makes the card the default, not an option", () => {
    const prompt = readFileSync(join(import.meta.dir, "..", "src/claude/system-prompt.ts"), "utf8");
    expect(prompt).toContain("send_location");
    // "available" would leave it optional; the rule has to be imperative or it
    // loses to the path of least resistance, which is typing the address.
    expect(prompt).toMatch(/THE DEFAULT WAY TO GIVE AN ADDRESS/);
    expect(prompt).toMatch(/Do NOT type a street address into your reply text/);
  });

  test("the delivery path only observes — it never rewrites or blocks", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/channels/deliver.ts"), "utf8");
    expect(src).toContain("looksLikeStreetAddress");
    // A false positive must cost nothing. If this ever becomes a mutation or a
    // return, a normal message gets damaged to enforce a nicety.
    const idx = src.indexOf("looksLikeStreetAddress(cleaned)");
    const block = src.slice(idx, idx + 320);
    expect(block).toContain("log.info");
    expect(block).not.toMatch(/return|cleaned\s*=/);
  });
});
