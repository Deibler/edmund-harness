/**
 * Pure unit tests for the intensity table. Resolution must clamp out-
 * of-range inputs, return monotonically-stricter cooldowns as level
 * drops, and emit non-empty eagerness text for every level.
 */
import { describe, expect, test } from "bun:test";
import { intensityTable, resolveIntensity } from "../src/ghost/intensity.ts";

describe("resolveIntensity", () => {
  test("returns the level-5 params at default", () => {
    const p = resolveIntensity(5);
    expect(p.cooldownHours).toBe(24);
    expect(p.weeklyCap).toBe(3);
    expect(p.eagerness).toContain("INTENSITY 5");
  });

  test("clamps below 1 → level 1", () => {
    expect(resolveIntensity(0)).toEqual(resolveIntensity(1));
    expect(resolveIntensity(-5)).toEqual(resolveIntensity(1));
  });

  test("clamps above 10 → level 10", () => {
    expect(resolveIntensity(11)).toEqual(resolveIntensity(10));
    expect(resolveIntensity(100)).toEqual(resolveIntensity(10));
  });

  test("floors fractional input", () => {
    expect(resolveIntensity(5.9)).toEqual(resolveIntensity(5));
    expect(resolveIntensity(3.1)).toEqual(resolveIntensity(3));
  });

  test("cooldown decreases monotonically as level rises", () => {
    for (let i = 2; i <= 10; i++) {
      expect(resolveIntensity(i).cooldownHours).toBeLessThanOrEqual(
        resolveIntensity(i - 1).cooldownHours,
      );
    }
  });

  test("weekly cap increases monotonically as level rises", () => {
    for (let i = 2; i <= 10; i++) {
      expect(resolveIntensity(i).weeklyCap).toBeGreaterThanOrEqual(
        resolveIntensity(i - 1).weeklyCap,
      );
    }
  });

  test("eagerness clause is non-empty for every level", () => {
    for (let i = 1; i <= 10; i++) {
      expect(resolveIntensity(i).eagerness.length).toBeGreaterThan(20);
    }
  });
});

describe("intensityTable", () => {
  test("returns all 10 rows sorted ascending", () => {
    const rows = intensityTable();
    expect(rows.length).toBe(10);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.level).toBe(i + 1);
    }
  });
});
