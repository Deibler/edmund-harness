/**
 * The published JSON Schema is the only description of a tool the model ever
 * sees. A zod type the converter cannot express is not a cosmetic gap — the
 * model is left guessing the call shape.
 *
 * This caught a real outage of exactly that kind: `render_mirror_content` is
 * `intersection(base, discriminatedUnion)`, the converter handled only a bare
 * ZodObject, and it published `{"type":"object","properties":{},"required":[]}`.
 * The model sent `{}` and then reverse-engineered the arguments from three
 * rejection messages before a widget appeared.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import { z } from "zod";
import { zodToJsonSchema } from "../src/mcp/zod-to-json.ts";

type Published = ReturnType<typeof zodToJsonSchema>;

describe("zodToJsonSchema", () => {
  test("publishes a plain object's fields and required set", () => {
    const js = zodToJsonSchema(
      z.object({ id: z.string(), count: z.number().int().min(1).optional() }),
    );
    expect(js.properties.id).toMatchObject({ type: "string" });
    expect(js.properties.count).toMatchObject({ type: "integer", minimum: 1 });
    expect(js.required).toEqual(["id"]);
  });

  test("merges an intersection instead of blanking it", () => {
    const js = zodToJsonSchema(
      z.intersection(z.object({ zone: z.string() }), z.object({ page: z.string().optional() })),
    );
    expect(Object.keys(js.properties).sort()).toEqual(["page", "zone"]);
    expect(js.required).toEqual(["zone"]);
  });

  test("gives a discriminated union a discriminator enum and one branch each", () => {
    const js = zodToJsonSchema(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), props: z.object({ x: z.string() }) }),
        z.object({ kind: z.literal("b"), props: z.object({ y: z.number() }) }),
      ]),
    );
    expect(js.properties.kind).toMatchObject({ type: "string", enum: ["a", "b"] });
    expect(js.oneOf).toHaveLength(2);
  });

  test("recurses into nested objects rather than calling them strings", () => {
    const js = zodToJsonSchema(z.object({ props: z.object({ title: z.string() }) }));
    const props = js.properties.props as Published;
    expect(props.type).toBe("object");
    expect(props.properties.title).toMatchObject({ type: "string" });
  });

  test("sees through .superRefine() (ZodEffects)", () => {
    const js = zodToJsonSchema(z.object({ rows: z.array(z.string()) }).superRefine(() => {}));
    expect(js.properties.rows).toMatchObject({ type: "array" });
  });

  test("sees through z.preprocess to the type the model should send", () => {
    const js = zodToJsonSchema(z.object({ temperature: z.preprocess((v) => v, z.string()) }));
    // Coercion is a server-side kindness; the model is still steered to string.
    expect(js.properties.temperature).toMatchObject({ type: "string" });
  });

  test("describes an unknown type as unconstrained, never as a wrong type", () => {
    const js = zodToJsonSchema(z.object({ payload: z.unknown() }));
    // A missing constraint costs a retry; a confident wrong one costs the call.
    expect(js.properties.payload).not.toMatchObject({ type: "string" });
  });

  test("publishes tuples as 2020-12 prefixItems, never draft-4 array-form items", () => {
    // The array form (`items: [a, b]`) is draft-4 syntax the Anthropic API
    // rejects with a 400 on the WHOLE request — kitchen_recipe_save's `needs`
    // tuple bricked every turn of the Alex DM this way (2026-08-17).
    const js = zodToJsonSchema(
      z.object({ needs: z.array(z.tuple([z.string(), z.number().nullable()])) }),
    );
    const tuple = (js.properties.needs as { items: Published }).items;
    expect(tuple).toMatchObject({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
      minItems: 2,
      maxItems: 2,
    });
    expect(Array.isArray(tuple.items)).toBe(false);
  });

  test("a tuple rest element becomes the items schema with no maxItems", () => {
    const js = zodToJsonSchema(z.object({ row: z.tuple([z.string()]).rest(z.number()) }));
    const tuple = js.properties.row as Record<string, unknown>;
    expect(tuple).toMatchObject({
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
      minItems: 1,
    });
    expect(tuple.maxItems).toBeUndefined();
  });

  test("carries enums, arrays and defaults through", () => {
    const js = zodToJsonSchema(
      z.object({
        tone: z.enum(["a", "b"]).default("a"),
        items: z.array(z.string()).min(1).max(3),
      }),
    );
    expect(js.properties.tone).toMatchObject({ enum: ["a", "b"], default: "a" });
    expect(js.properties.items).toMatchObject({ minItems: 1, maxItems: 3 });
  });
});

/**
 * Every published schema must satisfy the JSON Schema 2020-12 meta-schema —
 * the exact check the Anthropic API runs, and it rejects the WHOLE request
 * (400, every turn, unhealable) on any miss. This sweep walks the real
 * loadout so a converter gap or an exotic zod type in a NEW tool fails here,
 * in CI, instead of in somebody's iMessage thread at 4am.
 */
describe("every published tool schema is valid JSON Schema 2020-12", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-schema-sweep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const metaValidator = () => {
    const Ctor = ((AjvModule as { default?: unknown }).default ?? AjvModule) as new (
      opts: Record<string, unknown>,
    ) => { validateSchema: (s: unknown) => unknown; errors?: unknown };
    return new Ctor({ strict: false, validateFormats: false });
  };

  const assertAllValid = (tools: Array<{ name: string; inputSchema: z.ZodTypeAny }>) => {
    const ajv = metaValidator();
    const invalid = tools
      .map((t) => ({ name: t.name, schema: zodToJsonSchema(t.inputSchema, t.name) }))
      .filter((t) => !ajv.validateSchema(structuredClone(t.schema)));
    expect(invalid.map((t) => t.name)).toEqual([]);
    return tools.length;
  };

  test("core operator loadout", async () => {
    const { assembleCoreTools } = await import("../src/mcp/server.ts");
    const { ConfigSchema } = await import("../src/config/config.ts");
    const config = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
    });
    config.paths.data_dir = dir;
    const ctx = {
      config,
      cron: null,
      chatDb: null,
      contacts: null,
      sessionKey: "imessage:dm:+15559990000",
      chatGuids: [],
      sandboxPath: dir,
      dataDir: dir,
      bgJobs: null,
      guestTier: null,
    } as never;
    const count = assertAllValid(assembleCoreTools(ctx));
    expect(count).toBeGreaterThan(20);
  });

  test("kitchen integration loadout (the tools that caused the 2026-08-17 outage)", async () => {
    const { kitchenTools } = await import("../integrations/kitchen/tools.ts");
    const ctx = {
      sessionKey: "imessage:dm:+15559990000",
      config: { kitchen: { enabled: true } },
    } as never;
    const count = assertAllValid(kitchenTools(ctx));
    expect(count).toBeGreaterThan(10);
  });

  test("fishing integration publishes its two direct tools", async () => {
    const { fishingTools } = await import("../integrations/fishing/tools.ts");
    const ctx = {
      config: { fishing: { enabled: true } },
      sandboxPath: dir,
    } as never;
    const tools = fishingTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual(["fishing_query", "fishing_viz"]);
    expect(assertAllValid(tools)).toBe(2);
  });
});

describe("the mirror render tool as the model sees it", () => {
  test("publishes placement fields and every component variant", async () => {
    const { MirrorComponentSpecSchema } = await import("../integrations/mirror/src/protocol.ts");
    const js = zodToJsonSchema(
      z.intersection(
        z.object({ zone: z.string(), page: z.string().optional() }),
        MirrorComponentSpecSchema,
      ),
    );
    expect(js.properties.zone).toBeDefined();
    const component = js.properties.component as { enum: string[] };
    expect(component.enum).toContain("weather");
    expect(component.enum).toContain("stats");
    // One branch per component, each carrying its own required props — this is
    // what tells the model that `stats` needs `items`.
    expect(js.oneOf?.length).toBe(component.enum.length);
    const stats = js.oneOf?.find(
      (b) => (b.properties as Record<string, { const?: string }>).component?.const === "stats",
    );
    expect((stats?.required as string[]) ?? []).toContain("props");
  });

  test("publishes the intent enum on the real tool schema", async () => {
    // The real RenderInput, not a stand-in: `intent` is the field that now
    // carries the whole placement decision, so if the converter cannot express
    // it the model falls back to guessing zones — which is the behaviour it
    // was added to replace. `.refine()` would have done exactly that (it
    // produces a ZodEffects), which is why the invariant is a default instead.
    const { mirrorTools } = await import("../integrations/mirror/tools.ts");
    const { loadConfig } = await import("../src/config/config.ts");
    const config = loadConfig();
    const tools = mirrorTools({ config, dataDir: "./data", sessionKey: "test" } as never);
    const render = tools.find((tool) => tool.name === "render_mirror_content");
    if (!render) return; // mirror integration disabled in this environment

    const js = zodToJsonSchema(render.inputSchema as never);
    const intent = js.properties.intent as { enum?: string[]; description?: string };
    expect(intent?.enum).toEqual(["ambient", "answer", "focus"]);
    expect(intent?.description ?? "").toContain("ambient");
    // Zone survives as an override, and must NOT be advertised as required —
    // a required zone is a model that keeps choosing one.
    expect(js.properties.zone).toBeDefined();
    expect((js.required as string[]) ?? []).not.toContain("zone");
  });
});
