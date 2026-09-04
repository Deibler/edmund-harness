import { describe, expect, test } from "bun:test";
import {
  AgentFrameSchema,
  MirrorComponentSpecSchema,
  MirrorContentSchema,
  PiEventSchema,
  placementForIntent,
  placementZone,
} from "../integrations/mirror/src/protocol.ts";

describe("mirror v2 protocol", () => {
  test("accepts a typed text component and applies bounded defaults", () => {
    const spec = MirrorComponentSpecSchema.parse({
      component: "text_block",
      props: { text: "Good morning" },
    });
    expect(spec).toEqual({
      component: "text_block",
      props: { text: "Good morning", tone: "default" },
    });
  });

  test("rejects raw markup and unknown components", () => {
    expect(
      MirrorComponentSpecSchema.safeParse({
        component: "html",
        props: { html: "<script>alert(1)</script>" },
      }).success,
    ).toBe(false);
    expect(
      MirrorComponentSpecSchema.safeParse({
        component: "video",
        props: { src: "https://example.com/movie.mp4" },
      }).success,
    ).toBe(false);
    expect(
      MirrorComponentSpecSchema.safeParse({
        component: "image_card",
        props: { src: "javascript:alert(1)", alt: "bad" },
      }).success,
    ).toBe(false);
  });

  test("rejects malformed table and chart shapes", () => {
    expect(
      MirrorComponentSpecSchema.safeParse({
        component: "table",
        props: { columns: ["one", "two"], rows: [["only one"]] },
      }).success,
    ).toBe(false);
    expect(
      MirrorComponentSpecSchema.safeParse({
        component: "chart",
        props: { labels: ["a", "b"], values: [1] },
      }).success,
    ).toBe(false);
  });

  test("pins content identity, lifespan, revision, and timestamps", () => {
    const now = Date.now();
    const content = MirrorContentSchema.parse({
      id: "weather:home",
      page: "home",
      zone: "top_right",
      presentation: "widget",
      component: "weather",
      props: {
        location: "Home",
        temperature: "72°",
        condition: "Clear",
      },
      lifespan: "persistent",
      priority: 20,
      expiresAtMs: null,
      revision: 8,
      createdAtMs: now,
      updatedAtMs: now,
    });
    expect(content.protected).toBe(false);
    expect(content.component).toBe("weather");
    expect(MirrorContentSchema.safeParse({ ...content, page: "*" }).success).toBe(true);
    expect(MirrorContentSchema.safeParse({ ...content, page: "bad*page" }).success).toBe(false);
  });

  test("validates acknowledgement and snapshot discriminants", () => {
    const ack = PiEventSchema.parse({
      v: 2,
      type: "ack",
      replyTo: "content:abc",
      status: "accepted",
      revision: 4,
    });
    expect(ack.type).toBe("ack");

    const frame = AgentFrameSchema.parse({
      v: 2,
      id: "snapshot:abc",
      type: "snapshot",
      revision: 0,
      page: "home",
      rotation: 90,
      contents: [],
    });
    expect(frame.type).toBe("snapshot");
  });

  test("accepts authoritative working and responding overlay phases", () => {
    for (const phase of ["working", "responding"]) {
      expect(
        AgentFrameSchema.safeParse({
          v: 2,
          id: `overlay:${phase}`,
          type: "overlay_set",
          overlay: { phase },
        }).success,
      ).toBe(true);
    }
  });

  test("accepts a bounded streaming conversation and audio caption identity", () => {
    expect(
      AgentFrameSchema.safeParse({
        v: 2,
        id: "overlay:conversation",
        type: "overlay_set",
        overlay: {
          phase: "responding",
          messages: [
            { id: "user:one", role: "user", text: "Hello", final: true },
            {
              id: "assistant:one",
              role: "assistant",
              text: "Hi there",
              final: false,
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      AgentFrameSchema.safeParse({
        v: 2,
        id: "audio:one",
        type: "audio_play",
        format: "wav",
        data: "YXVkaW8=",
        text: "Hi there",
        messageId: "assistant:one",
      }).success,
    ).toBe(true);
  });
});

describe("forgiving props (real rejections from the 2026-07-24 mirror session)", () => {
  // Each of these cost a full model retry round-trip for something that
  // renders identically once accepted.
  test("a weather card written with numeric temperatures is accepted", () => {
    const parsed = MirrorComponentSpecSchema.safeParse({
      component: "weather",
      props: {
        location: "Lancaster, PA",
        temperature: 77,
        condition: "Mostly Cloudy",
        high: 78,
        low: 68,
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const props = parsed.data.props as Record<string, unknown>;
    expect(props.temperature).toBe("77");
    expect(props.high).toBe("78");
  });

  test("numbers are stringified wherever a widget shows text", () => {
    const table = MirrorComponentSpecSchema.safeParse({
      component: "table",
      props: { columns: ["Stat", "Value"], rows: [["PPG", 27.1]] },
    });
    expect(table.success).toBe(true);
    if (table.success) {
      expect((table.data.props as { rows: string[][] }).rows[0]).toEqual(["PPG", "27.1"]);
    }

    const stats = MirrorComponentSpecSchema.safeParse({
      component: "stats",
      props: { items: [{ label: "Games", value: 82 }] },
    });
    expect(stats.success).toBe(true);

    const chart = MirrorComponentSpecSchema.safeParse({
      component: "chart",
      props: { labels: [2024, 2025], values: [1, 2] },
    });
    expect(chart.success).toBe(true);
  });

  test("a list of plain strings still parses, and gains the richer shape", () => {
    // `items: string[]` forced everything into the sentence — "Milk - 2 left"
    // — so the renderer had one blob per row and nowhere to put the fact you
    // were scanning for. The old shape has to keep working regardless: every
    // refresh script and cron in the database was written against it.
    const old = MirrorComponentSpecSchema.safeParse({
      component: "list_card",
      props: { items: ["Milk", "Bread"] },
    });
    expect(old.success).toBe(true);
    if (old.success) {
      expect((old.data.props as { items: unknown[] }).items).toEqual([
        { text: "Milk" },
        { text: "Bread" },
      ]);
    }

    const rich = MirrorComponentSpecSchema.safeParse({
      component: "list_card",
      props: { items: [{ text: "Milk", meta: "2 left" }, { text: "Bread" }] },
    });
    expect(rich.success).toBe(true);
    if (rich.success) {
      const items = (rich.data.props as { items: Array<{ text: string; meta?: string }> }).items;
      expect(items[0]).toEqual({ text: "Milk", meta: "2 left" });
    }

    // A row with no text is still a rejection: that is a misunderstood field,
    // not a shape to forgive.
    expect(
      MirrorComponentSpecSchema.safeParse({
        component: "list_card",
        props: { items: [{ meta: "2 left" }] },
      }).success,
    ).toBe(false);
  });

  test("a boolean is still rejected — that means the field was misunderstood", () => {
    const parsed = MirrorComponentSpecSchema.safeParse({
      component: "weather",
      props: { location: true, temperature: "77", condition: "Clear" },
    });
    expect(parsed.success).toBe(false);
  });

  describe("weather icon", () => {
    const icon = (value: unknown): unknown => {
      const parsed = MirrorComponentSpecSchema.safeParse({
        component: "weather",
        props: { location: "L", temperature: "77", condition: "c", icon: value },
      });
      if (!parsed.success) return "REJECTED";
      return (parsed.data.props as Record<string, unknown>).icon;
    };

    test("maps forecast vocabulary onto the glyphs the mirror actually draws", () => {
      expect(icon("Partly Cloudy")).toBe("cloud");
      expect(icon("partly_cloudy")).toBe("cloud");
      expect(icon("thunderstorms")).toBe("storm");
      expect(icon("chance of showers")).toBe("rain");
      expect(icon("Clear")).toBe("sun");
    });

    test("passes canonical values through untouched", () => {
      expect(icon("sun")).toBe("sun");
      expect(icon("fog")).toBe("fog");
    });

    test("a compound that names the glyph itself still finds it", () => {
      // "Light Rain" came off the live NWS feed and matched nothing:
      // "light-rain" is not a canonical icon, and no ALIAS key is a substring
      // of it, because the word it contains is "rain" — the icon itself. The
      // card fell back to printing the condition beside the temperature for
      // the most ordinary weather there is.
      expect(icon("Light Rain")).toBe("rain");
      expect(icon("Heavy Snow")).toBe("snow");
      expect(icon("Patchy Fog")).toBe("fog");
    });

    test("drops an unrecognized icon instead of failing the whole card", () => {
      // A weather card with no glyph beats no weather card.
      expect(icon("kaleidoscopic")).toBeUndefined();
    });
  });
});

/**
 * The corner zones are a third of the glass. A model asked for news picked
 * `bottom_left` + `list_card` and five eighty-character headlines wrapped at
 * about seven characters a line, which is arithmetic rather than taste — so
 * the width is taken out of the model's hands.
 */
describe("placementZone", () => {
  test("prose is promoted out of every narrow corner", () => {
    expect(placementZone("bottom_left", "story_list")).toBe("lower_third");
    expect(placementZone("bottom_center", "text_block")).toBe("lower_third");
    expect(placementZone("bottom_right", "list_card")).toBe("lower_third");
    expect(placementZone("top_left", "menu")).toBe("upper_third");
    expect(placementZone("top_center", "table")).toBe("upper_third");
    expect(placementZone("top_right", "recipe")).toBe("upper_third");
  });

  test("the model still chooses top versus bottom", () => {
    // The half of the decision it actually has an opinion about survives.
    expect(placementZone("top_left", "story_list")).toBe("upper_third");
    expect(placementZone("bottom_left", "story_list")).toBe("lower_third");
  });

  test("ambient fixtures keep their corner", () => {
    // These are the whole reason the corners exist.
    expect(placementZone("top_left", "clock")).toBe("top_left");
    expect(placementZone("top_right", "weather")).toBe("top_right");
    expect(placementZone("bottom_left", "status")).toBe("bottom_left");
  });

  test("an image is an answer, not a fixture", () => {
    // image_card used to be ambient on the reasoning that a picture has no
    // line length to break. It has a SIZE instead: sent to a corner it renders
    // at a third of the glass. The August calendar the model produced landed
    // there at 460x260 and nothing in it was legible.
    expect(placementZone("bottom_right", "image_card")).toBe("lower_third");
    expect(placementZone("top_center", "image_card")).toBe("upper_third");
  });
});

/**
 * The intent is the model's ONE placement decision. Everything below is the
 * device making the other four on its behalf.
 */
describe("placementForIntent", () => {
  test("an intent answers all four layout questions, not just one", () => {
    // The point of the intent is that a model saying what content is FOR
    // never has to have an opinion about a zone, a presentation, a lifespan
    // or a priority — all four of which depend on the panel and on where the
    // dock is about to open.
    expect(placementForIntent("answer", "text_block")).toEqual({
      zone: "upper_third",
      presentation: "widget",
      lifespan: "ephemeral",
      priority: 0,
    });
    expect(placementForIntent("focus", "recipe")).toEqual({
      zone: "middle_center",
      presentation: "page",
      lifespan: "session",
      priority: 50,
    });
  });

  test("an answer goes up, because the dock is about to cover the bottom", () => {
    // The dock reserves 11rem across the bottom while the conversation that
    // produced the answer is still live. An answer placed low is one the
    // waterline slides under.
    expect(placementForIntent("answer", "story_list").zone).toBe("upper_third");
  });

  test("ambient fixtures go to their conventional corner", () => {
    expect(placementForIntent("ambient", "weather").zone).toBe("top_right");
    expect(placementForIntent("ambient", "clock").zone).toBe("top_left");
    // Anything without a conventional home takes the quiet corner rather than
    // the top row, which is the one you read without meaning to.
    expect(placementForIntent("ambient", "tracker").zone).toBe("bottom_left");
  });

  test("ambient never means persistent", () => {
    // Persistent content outlives everything and has to be deliberately
    // removed, so it is what the user ASKS for — not what a model infers from
    // "this is ambient". The failure mode is a glass that slowly fills with
    // widgets nobody chose and nobody clears.
    for (const component of ["weather", "tracker", "status", "progress"]) {
      expect(placementForIntent("ambient", component).lifespan).toBe("session");
    }
  });

  test("zones that are already full width are untouched", () => {
    expect(placementZone("upper_third", "story_list")).toBe("upper_third");
    expect(placementZone("lower_third", "story_list")).toBe("lower_third");
    expect(placementZone("middle_center", "text_block")).toBe("middle_center");
    expect(placementZone("fullscreen_above", "video")).toBe("fullscreen_above");
  });
});

describe("story_list schema", () => {
  const parse = (props: unknown) =>
    MirrorComponentSpecSchema.safeParse({ component: "story_list", props });

  test("accepts headlines with their source and age intact", () => {
    const result = parse({
      title: "Breaking",
      stories: [
        { headline: "Talks progress on Hormuz", source: "Reuters", age: "2h" },
        { headline: "Tariffs land on sixty partners", source: "AP" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("a headline is required; a bare string list is not a story", () => {
    expect(parse({ stories: ["Talks progress on Hormuz"] }).success).toBe(false);
    expect(parse({ stories: [{ source: "Reuters" }] }).success).toBe(false);
  });

  test("caps the column at six so it can never outgrow the band", () => {
    const stories = Array.from({ length: 7 }, (_, i) => ({ headline: `story ${i}` }));
    expect(parse({ stories }).success).toBe(false);
  });
});
