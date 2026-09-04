import { describe, expect, test } from "bun:test";
import {
  MIRROR_CLOSE_TOOL_NAME,
  MirrorLifespanInputSchema,
  UpdateInput,
  toContentInput,
} from "../integrations/mirror/tools.ts";

/** Parse the way the tool handler does, then resolve placement. */
const resolve = (input: unknown, ttl = 120) =>
  toContentInput(UpdateInput.parse(input) as never, ttl);

describe("Mirror tool inputs", () => {
  test("exposes the exact always-present Close() tool name", () => {
    expect(MIRROR_CLOSE_TOOL_NAME).toBe("Close");
  });

  test("accepts the natural lifespan shorthand used by the model", () => {
    expect(MirrorLifespanInputSchema.parse("persistent")).toEqual({
      mode: "persistent",
    });
    expect(
      MirrorLifespanInputSchema.parse({
        mode: "ephemeral",
        ttl_seconds: 90,
      }),
    ).toEqual({
      mode: "ephemeral",
      ttl_seconds: 90,
    });
  });
});

/**
 * `intent` took over four fields that used to be stated one at a time. Every
 * refresh script and cron already in the database was written against the old
 * shape, and they run unattended — a placement that quietly changed under them
 * would show up as widgets drifting to new corners with nobody having touched
 * anything.
 */
describe("placement resolution", () => {
  const weather = {
    id: "weather",
    component: "weather" as const,
    props: { location: "Lancaster", temperature: "84", condition: "Cloudy" },
  };

  test("a caller that states everything the old way is untouched", () => {
    // Verbatim shape of the live `weather-widget` refresh script.
    const resolved = resolve({
      ...weather,
      page: "home",
      zone: "top_right",
      presentation: "widget",
      lifespan: "session",
    });
    expect(resolved.zone).toBe("top_right");
    expect(resolved.presentation).toBe("widget");
    expect(resolved.lifespan).toBe("session");
    expect(resolved.expiresAtMs).toBeNull();
  });

  test("a caller that states only a zone keeps the defaults it always had", () => {
    // Before intents these four carried per-field defaults: widget, ephemeral,
    // priority 0. "answer" resolves to exactly those, which is what makes the
    // default safe rather than merely convenient.
    const resolved = resolve({ ...weather, zone: "bottom_right" });
    expect(resolved.zone).toBe("bottom_right");
    expect(resolved.presentation).toBe("widget");
    expect(resolved.lifespan).toBe("ephemeral");
    expect(resolved.priority).toBe(0);
    expect(resolved.expiresAtMs).not.toBeNull();
  });

  test("an intent alone is enough", () => {
    const resolved = resolve({ ...weather, intent: "ambient" });
    expect(resolved.zone).toBe("top_right");
    expect(resolved.lifespan).toBe("session");
    expect(resolved.priority).toBe(-10);
  });

  test("an explicit field beats the intent that would have chosen it", () => {
    // "Usually the device knows better" is not "the device always knows
    // better" — an override that the intent silently ignored would be worse
    // than not offering one.
    const resolved = resolve({ ...weather, intent: "ambient", zone: "bottom_center" });
    expect(resolved.zone).toBe("bottom_center");
    expect(resolved.lifespan).toBe("session");
  });

  test("legibility still outranks the intent", () => {
    // An "ambient" list_card is still prose, and a corner column is a third of
    // the glass — about seven characters a line. It lands in a full-width band
    // at ambient priority, which is the sane reading of the request rather
    // than an error to argue with every turn.
    const resolved = resolve({
      id: "notes",
      component: "list_card" as const,
      props: { items: ["milk", "bread"] },
      intent: "ambient",
    });
    expect(resolved.zone).toBe("lower_third");
    expect(resolved.priority).toBe(-10);
  });

  test("focus takes the whole glass rather than a band", () => {
    const resolved = resolve({
      id: "dinner",
      component: "recipe" as const,
      props: { title: "Carbonara", ingredients: ["Guanciale"], steps: ["Boil water"] },
      intent: "focus",
    });
    expect(resolved.presentation).toBe("page");
    expect(resolved.priority).toBe(50);
  });
});
