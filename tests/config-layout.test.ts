import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { serializeToml } from "../dashboard/server/services/configIO.ts";
import { ConfigSchema } from "../src/config/config.ts";
import {
  CONFIG_LAYOUT,
  HEADER,
  formatChecked,
  formatConfig,
  layoutOrder,
  machineNotes,
} from "../src/config/layout.ts";

const root = join(import.meta.dir, "..");
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const same = (a: unknown, b: unknown) => isDeepStrictEqual(plain(a), plain(b));
const headers = (text: string) =>
  [...text.matchAll(/^\s*#?\s*\[\[?([a-z_.]+)\]\]?\s*$/gm)].map((m) => m[1]!);

const schemaSections = () => {
  const def = ConfigSchema as unknown as { shape?: unknown; _def: { shape?: () => object } };
  const shape = (def.shape ?? def._def.shape?.()) as object;
  return Object.keys(shape);
};

/** The layout name a header belongs to: itself, or the longest layout prefix (mcp_servers.x → mcp_servers). */
const owner = (name: string) => {
  const order = layoutOrder();
  if (order.includes(name)) return name;
  return (
    order.filter((o) => name.startsWith(`${o}.`)).sort((a, b) => b.length - a.length)[0] ?? name
  );
};

const sample = {
  orchestrators: [],
  claude: {
    model: "m",
    effort: "high",
    pool: { enabled: true, max_workers: 2 },
    auto_compact: { threshold_tokens: 1 },
  },
  keys: { openrouter: "sk-test" },
  contacts: [{ name: "Sam", handles: ["+15555550101"] }],
  guest_campaigns: [
    { key: "k1", label: "L" },
    { key: "k2", label: "M" },
  ],
  mcp_servers: {
    example: { type: "http", url: "https://example.com", headers: { Authorization: "Bearer x" } },
  },
  trading: { enabled: false, mcp_headers: {}, mcp_servers: {} },
  brand_new_section: { a: 1 },
  behavior: { debounce_ms: 1500 },
};

describe("every config section has a place", () => {
  test("each section in the schema is placed in exactly one tier", () => {
    const placed = layoutOrder();
    for (const s of schemaSections()) expect([s, placed.includes(s)]).toEqual([s, true]);
    expect(new Set(placed).size).toBe(placed.length);
  });

  test("every section says what it is for", () => {
    for (const tier of CONFIG_LAYOUT)
      for (const s of tier.sections) expect(s.note.length).toBeGreaterThan(10);
  });
});

describe("the formatter moves things and changes nothing", () => {
  test("a config comes back value for value, and formatting twice changes nothing", () => {
    const text = formatConfig(sample);
    expect(same(parse(text), sample)).toBe(true);
    expect(formatConfig(parse(text) as Record<string, unknown>, machineNotes(text))).toBe(text);
  });

  test("the example config round-trips too", () => {
    const example = parse(readFileSync(join(root, "config.example.toml"), "utf8"));
    expect(same(parse(formatConfig(example as Record<string, unknown>)), example)).toBe(true);
  });

  test("sections land in tier order: the knobs first, the plumbing last", () => {
    const order = headers(formatConfig(sample))
      .map(owner)
      .filter((h) => layoutOrder().includes(h));
    const positions = order.map((h) => layoutOrder().indexOf(h));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const text = formatConfig(sample);
    expect(text.indexOf("[claude]")).toBeLessThan(text.indexOf("[keys]"));
    expect(text.indexOf("[keys]")).toBeLessThan(text.indexOf("[claude.auto_compact]"));
  });

  test("a section the layout does not know is kept, at the end", () => {
    const text = formatConfig(sample);
    expect(text).toContain("[brand_new_section]");
    expect(text.indexOf("[brand_new_section]")).toBeGreaterThan(text.indexOf("[behavior]"));
  });

  test("notes at the top of a file survive, without stacking a second header", () => {
    const first = formatConfig(sample, ["# This Mac's iCloud login is the bot account."]);
    const notes = machineNotes(first);
    expect(notes).toEqual(["# This Mac's iCloud login is the bot account."]);
    const second = formatConfig(sample, notes);
    expect(second.split(HEADER[0]!).length).toBe(2);
    expect(second).toBe(first);
    expect(machineNotes("# my note\n\n[claude]\nmodel = 'm'\n")).toEqual(["# my note"]);
  });
});

describe("the example and the dashboard follow the same layout", () => {
  test("config.example.toml lists its sections in layout order", () => {
    const text = readFileSync(join(root, "config.example.toml"), "utf8");
    const positions = headers(text)
      .map(owner)
      .filter((h) => layoutOrder().includes(h))
      .map((h) => layoutOrder().indexOf(h));
    expect(positions.length).toBeGreaterThan(30);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const tier of CONFIG_LAYOUT) expect(text).toContain(`# ${tier.title.toUpperCase()}`);
  });

  test("a dashboard save writes the layout and refuses one that would change a value", () => {
    const text = serializeToml(sample);
    expect(text.startsWith(HEADER[0]!)).toBe(true);
    expect(same(parse(text), sample)).toBe(true);
    const dropsAKey = (o: Record<string, unknown>) => formatConfig({ ...o, behavior: undefined });
    expect(() => formatChecked(sample, [], dropsAKey)).toThrow("would change a value");
  });
});
