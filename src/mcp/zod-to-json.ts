import AjvModule from "ajv/dist/2020.js";
import type { z } from "zod";
import { log } from "../util/log.ts";

type JsonSchema = Record<string, unknown>;

type ObjectSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
  oneOf?: JsonSchema[];
};

/**
 * Convert a zod schema to the JSON Schema MCP publishes for a tool.
 *
 * This is the ONLY description of a tool the model ever sees, so a type this
 * converter does not understand is not a cosmetic gap — the model is left
 * guessing the call shape and discovers it by trial and error. That happened
 * for real: `render_mirror_content` is `intersection(base, discriminatedUnion)`,
 * the old converter handled only a bare ZodObject, and it published
 * `{"type":"object","properties":{},"required":[]}`. The model dutifully sent
 * `{}` and then reverse-engineered the arguments from three rejection messages
 * before anything appeared on the glass.
 *
 * So: unwrap every wrapper, recurse into nested objects and arrays, and give
 * unions a real shape. Anything genuinely unknown becomes an unconstrained
 * `{}` rather than a confident lie like `{"type":"string"}` — a missing
 * constraint costs a retry, a wrong one costs the call.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny, label?: string): ObjectSchema {
  const node = toSchema(schema);
  const published =
    node.type === "object"
      ? (node as ObjectSchema)
      : // MCP requires the top level to be an object. Anything else is a tool
        // definition bug, but publishing an empty object beats publishing nothing.
        ({ type: "object", properties: {}, required: [] } as ObjectSchema);

  // The API validates every tool's schema against the 2020-12 meta-schema and
  // rejects the ENTIRE request on any miss — one bad tool bricks every turn of
  // every session that loaded it, with no healer that can help (the schema is
  // static). So no schema leaves this module unchecked: an invalid one is
  // demoted to the permissive fallback (zod still enforces the real contract
  // at call time) and logged loudly enough to be fixed the same day.
  if (!meetsMetaSchema(published)) {
    log.error(
      "mcp",
      "tool schema failed JSON Schema 2020-12 meta-validation; publishing permissive fallback",
      {
        tool: label ?? "?",
        errors: metaSchemaErrors(),
        schema: JSON.stringify(published).slice(0, 400),
      },
    );
    return { type: "object", properties: {}, required: [] };
  }
  return published;
}

// Ajv's 2020-12 build is CJS; bun surfaces it as the default export or as
// `.default` depending on the importer. Instantiated lazily once per process.
type AjvInstance = { validateSchema: (s: unknown) => unknown; errors?: unknown };
let ajv: AjvInstance | null = null;

function meetsMetaSchema(schema: JsonSchema): boolean {
  try {
    if (!ajv) {
      const Ctor = ((AjvModule as { default?: unknown }).default ?? AjvModule) as new (
        opts: Record<string, unknown>,
      ) => AjvInstance;
      ajv = new Ctor({ strict: false, validateFormats: false });
    }
    return Boolean(ajv.validateSchema(structuredClone(schema)));
  } catch (err) {
    // A meta-validator that cannot run must not take every tool down with it.
    log.warn("mcp", "schema meta-validation unavailable, publishing unchecked", {
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

function metaSchemaErrors(): string {
  const errs = ajv?.errors;
  if (!Array.isArray(errs)) return "";
  return errs
    .map(
      (e) =>
        `${(e as { instancePath?: string }).instancePath}: ${(e as { message?: string }).message}`,
    )
    .join("; ")
    .slice(0, 500);
}

/** Wrappers that carry no shape of their own — peel and keep going. */
const TRANSPARENT = new Set([
  "ZodOptional",
  "ZodNullable",
  "ZodDefault",
  "ZodReadonly",
  "ZodBranded",
  "ZodCatch",
  "ZodPromise",
]);

function toSchema(field: z.ZodTypeAny): JsonSchema {
  const def = field._def as Record<string, unknown>;
  const typeName = def.typeName as string;
  const description = (field as { description?: string }).description;
  const base: JsonSchema = description ? { description } : {};

  if (TRANSPARENT.has(typeName)) {
    const inner = toSchema(def.innerType as z.ZodTypeAny);
    // A default is worth publishing: it tells the model what it gets for free.
    const withDefault = typeName === "ZodDefault" ? { default: safeDefault(def.defaultValue) } : {};
    return { ...inner, ...withDefault, ...base };
  }
  // .refine()/.superRefine()/.transform() wrap the real schema in ZodEffects.
  // Two of the mirror's component schemas use superRefine, so skipping this
  // would silently blank them out.
  if (typeName === "ZodEffects") return { ...toSchema(def.schema as z.ZodTypeAny), ...base };
  if (typeName === "ZodPipeline") return { ...toSchema(def.in as z.ZodTypeAny), ...base };

  if (typeName === "ZodObject") return { ...objectSchema(field), ...base };
  if (typeName === "ZodIntersection") {
    return {
      ...mergeObjects(toSchema(def.left as z.ZodTypeAny), toSchema(def.right as z.ZodTypeAny)),
      ...base,
    };
  }
  if (typeName === "ZodDiscriminatedUnion") {
    return { ...discriminatedUnionSchema(def), ...base };
  }
  if (typeName === "ZodUnion") {
    return { anyOf: (def.options as z.ZodTypeAny[]).map(toSchema), ...base };
  }

  if (typeName === "ZodString") return { type: "string", ...stringChecks(def), ...base };
  if (typeName === "ZodNumber") return { ...numberSchema(def), ...base };
  if (typeName === "ZodBoolean") return { type: "boolean", ...base };
  if (typeName === "ZodLiteral") return { const: def.value, ...base };
  if (typeName === "ZodEnum") return { type: "string", enum: def.values, ...base };
  if (typeName === "ZodNativeEnum") {
    return { enum: Object.values(def.values as Record<string, unknown>), ...base };
  }
  if (typeName === "ZodArray") {
    return {
      type: "array",
      items: toSchema(def.type as z.ZodTypeAny),
      ...arrayChecks(def),
      ...base,
    };
  }
  if (typeName === "ZodTuple") {
    // Draft 2020-12 spells tuples as `prefixItems`; the array form of `items`
    // is draft-4 syntax the Anthropic API rejects with a 400 on the WHOLE
    // request — one such tool bricked every turn of a session for real
    // (kitchen_recipe_save's `needs`, 2026-08-17).
    const items = (def.items as z.ZodTypeAny[]).map(toSchema);
    const rest = def.rest as z.ZodTypeAny | null;
    return {
      type: "array",
      prefixItems: items,
      // `items` governs elements past the prefix: the rest schema when the
      // tuple has one, otherwise none allowed.
      items: rest ? toSchema(rest) : false,
      minItems: items.length,
      ...(rest ? {} : { maxItems: items.length }),
      ...base,
    };
  }
  if (typeName === "ZodRecord") {
    return {
      type: "object",
      additionalProperties: toSchema(def.valueType as z.ZodTypeAny),
      ...base,
    };
  }
  // ZodAny / ZodUnknown / anything new: no constraint rather than a wrong one.
  return base;
}

function objectSchema(field: z.ZodTypeAny): ObjectSchema {
  const shape = (field._def as { shape: () => Record<string, z.ZodTypeAny> }).shape();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = toSchema(value);
    if (!value.isOptional()) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** intersection(A, B) — the call must satisfy both, so publish the union of
 *  their properties and requirements. */
function mergeObjects(left: JsonSchema, right: JsonSchema): JsonSchema {
  const merged: ObjectSchema = {
    type: "object",
    properties: {
      ...((left.properties as Record<string, unknown>) ?? {}),
      ...((right.properties as Record<string, unknown>) ?? {}),
    },
    required: [
      ...new Set([...((left.required as string[]) ?? []), ...((right.required as string[]) ?? [])]),
    ],
  };
  // Keep whichever side carried variant detail (a discriminated union), and
  // drop additionalProperties:false — with oneOf present it would contradict
  // the branch-only properties.
  const oneOf = (left.oneOf as JsonSchema[]) ?? (right.oneOf as JsonSchema[]);
  if (oneOf) merged.oneOf = oneOf;
  else merged.additionalProperties = false;
  return merged;
}

/**
 * A discriminated union becomes one object plus `oneOf` branches.
 *
 * The flat part (discriminator enum + every branch key present as a permissive
 * type) is what a client that ignores `oneOf` still sees; the branches carry
 * the exact per-variant shape. Publishing only `oneOf` would leave simpler
 * clients with no properties at all — the very failure this converter exists
 * to prevent.
 */
function discriminatedUnionSchema(def: Record<string, unknown>): ObjectSchema {
  const discriminator = def.discriminator as string;
  const options = def.options as z.ZodTypeAny[];
  const branches: JsonSchema[] = [];
  const discriminatorValues: unknown[] = [];
  const flat: Record<string, unknown> = {};

  for (const option of options) {
    const branch = objectSchema(option);
    const props = branch.properties as Record<string, JsonSchema>;
    const tag = props[discriminator]?.const;
    if (tag !== undefined) discriminatorValues.push(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === discriminator) continue;
      // First branch wins the flat slot; the branches hold the real detail.
      if (!(key in flat)) flat[key] = stripDescription(value);
    }
    branches.push({
      type: "object",
      properties: props,
      required: branch.required,
    });
  }

  return {
    type: "object",
    properties: {
      [discriminator]: { type: "string", enum: discriminatorValues },
      ...flat,
    },
    required: [discriminator],
    oneOf: branches,
  };
}

/** In the flat fallback a per-variant description would misdescribe the others. */
function stripDescription(schema: JsonSchema): JsonSchema {
  if (schema.type === "object") return { type: "object" };
  const { description: _drop, ...rest } = schema;
  return rest;
}

function stringChecks(def: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = {};
  for (const check of (def.checks as Array<Record<string, unknown>>) ?? []) {
    if (check.kind === "min") out.minLength = check.value;
    if (check.kind === "max") out.maxLength = check.value;
    if (check.kind === "regex") out.pattern = String(check.regex).replace(/^\/|\/[a-z]*$/g, "");
    if (check.kind === "url") out.format = "uri";
    if (check.kind === "email") out.format = "email";
  }
  return out;
}

function numberSchema(def: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = { type: "number" };
  for (const check of (def.checks as Array<Record<string, unknown>>) ?? []) {
    if (check.kind === "int") out.type = "integer";
    if (check.kind === "min") out.minimum = check.value;
    if (check.kind === "max") out.maximum = check.value;
  }
  return out;
}

function arrayChecks(def: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = {};
  const min = def.minLength as { value: number } | null;
  const max = def.maxLength as { value: number } | null;
  if (min) out.minItems = min.value;
  if (max) out.maxItems = max.value;
  return out;
}

/** Defaults are declared as thunks; a throwing one must not break the schema. */
function safeDefault(thunk: unknown): unknown {
  try {
    return typeof thunk === "function" ? (thunk as () => unknown)() : thunk;
  } catch {
    return undefined;
  }
}
