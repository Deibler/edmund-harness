/**
 * Phase-4 memory architecture: structure-aware chunking, hybrid
 * (dense+BM25) search, same-dim model-change purge, and the person-file
 * archive size gate. Evidence base in
 * docs/research/memory-architecture-2026-07-28.md.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { chunkMarkdownDoc, chunkPlainText } from "../src/memory/chunker.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { Indexer } from "../src/memory/indexer.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";
import {
  ARCHIVE_TARGET_BYTES,
  ARCHIVE_TRIGGER_BYTES,
  KEEP_RECENT_BULLETS,
  archiveGroupFile,
  archivePersonFile,
  sweepGroupArchives,
  sweepPersonArchives,
} from "../src/persona/archive.ts";

// ─── Chunker ──────────────────────────────────────────────────────────

describe("chunkMarkdownDoc", () => {
  const bullets = (n: number, month: string) =>
    Array.from(
      { length: n },
      (_, i) =>
        `- **2026-${month}-${String((i % 28) + 1).padStart(2, "0")}** — fact number ${i} with enough words to carry some real content in the line`,
    ).join("\n");

  test("splits by section with breadcrumb headers, bullets never split", () => {
    const body = [
      "# Pat Example",
      "",
      "- **Phone:** +15550100002",
      "",
      "## Who He Is",
      "Alex's dad. Print shop guy.",
      "",
      "## What I've Learned",
      bullets(60, "05"),
    ].join("\n");
    const chunks = chunkMarkdownDoc("Pat Example", body);
    expect(chunks.length).toBeGreaterThan(2);
    // Every chunk leads with its breadcrumb.
    for (const c of chunks) {
      expect(c.text.startsWith("Pat Example")).toBe(true);
    }
    const learned = chunks.filter((c) => c.text.startsWith("Pat Example > What I've Learned"));
    expect(learned.length).toBeGreaterThan(1); // 60 bullets ≈ several chunks
    // Size discipline: no chunk exceeds the hard cap.
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2_100);
    // Bullets survive whole — every dated bullet appears exactly once.
    const joined = chunks.map((c) => c.text).join("\n");
    expect(joined).toContain("fact number 0 ");
    expect(joined).toContain("fact number 59 ");
    // A bullet is never split mid-line across chunks.
    for (const c of chunks) {
      for (const line of c.text.split("\n")) {
        if (line.startsWith("- **2026-")) expect(line).toMatch(/fact number \d+/);
      }
    }
  });

  test("empty scaffold sections are skipped", () => {
    const body = "# X\n\n## Open Items\n\n## Shared History\n(nothing)";
    const chunks = chunkMarkdownDoc("X", body);
    expect(chunks.length).toBe(0);
  });
});

describe("chunkPlainText", () => {
  test("chunks long artifacts with the title on every chunk", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} of a long sandbox note`).join(
      "\n",
    );
    const chunks = chunkPlainText("[sandbox file: /x/note.md · 2026-07-28]", body);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.startsWith("[sandbox file:")).toBe(true);
  });
});

// ─── Hybrid search + model purge ──────────────────────────────────────

function makeRow(
  provider: HashEmbedProvider,
  vecOf: Map<string, Float32Array>,
  ref: string,
  text: string,
  over: Partial<IndexRow> = {},
): IndexRow {
  const vec = vecOf.get(text)!;
  return {
    ref,
    kind: "message",
    chatGuid: "iMessage;-;+15550100001",
    sender: "+15550100001",
    ts: Date.now(),
    text,
    vec,
    model: provider.model,
    ...over,
  };
}

describe("hybrid search (dense + BM25 RRF)", () => {
  test("sparse leg rescues an exact-term hit the dense floor rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    const provider = new HashEmbedProvider();
    try {
      // Diluted doc: contains the rare term "zebra" among 40 fillers, so
      // its cosine to the query "zebra" is far below the floor.
      const diluted = `zebra ${Array.from({ length: 40 }, (_, i) => `filler${i}`).join(" ")}`;
      const near = "giraffe savanna animals walking";
      const texts = [diluted, near, "zebra"];
      const embedded = await provider.embed(texts);
      const vecOf = new Map(texts.map((t, i) => [t, normalize(embedded.vectors[i]!)]));
      store.upsert([
        makeRow(provider, vecOf, "msg:a", diluted),
        makeRow(provider, vecOf, "msg:b", near),
      ]);
      const qvec = vecOf.get("zebra")!;

      const denseOnly = store.search(qvec, {
        scope: { kind: "global" },
        minScore: 0.5,
        limit: 5,
      });
      expect(denseOnly.map((h) => h.ref)).not.toContain("msg:a");

      const hybrid = store.search(qvec, {
        scope: { kind: "global" },
        minScore: 0.5,
        limit: 5,
        queryText: "zebra",
      });
      expect(hybrid.map((h) => h.ref)).toContain("msg:a");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same-dim model change purges stale rows instead of mixing spaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    const provider = new HashEmbedProvider();
    try {
      const r = await provider.embed(["hello world"]);
      const vecOf = new Map([["hello world", normalize(r.vectors[0]!)]]);
      store.resetIfModelChanged(provider.model, provider.dim);
      store.upsert([makeRow(provider, vecOf, "msg:x", "hello world")]);
      expect(store.count()).toBe(1);
      // New model, SAME dim — the old rows must go, or every future
      // search would score vectors from two incompatible spaces.
      expect(store.resetIfModelChanged("new-model", provider.dim)).toBe(true);
      expect(store.count()).toBe(0);
      const hits = store.search(vecOf.get("hello world")!, {
        scope: { kind: "global" },
        limit: 5,
        queryText: "hello",
      });
      expect(hits.length).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("countDocsByKind counts documents, not chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    const provider = new HashEmbedProvider();
    try {
      const r = await provider.embed(["a", "b", "c"]);
      const rows: IndexRow[] = ["a", "b", "c"].map((t, i) => ({
        ref: `artifact:/x/f.md#${i}`,
        kind: "artifact",
        chatGuid: null,
        sender: null,
        ts: 1,
        text: t,
        vec: normalize(r.vectors[i]!),
        model: provider.model,
      }));
      store.upsert(rows);
      expect(store.countByKind("artifact")).toBe(3);
      expect(store.countDocsByKind("artifact")).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Person-file archive size gate ────────────────────────────────────

function bigPersonFile(): string {
  const bullet = (month: number, day: number, i: number) =>
    `- **2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}** — entry ${i}: ${"detail ".repeat(20)}`;
  const learned: string[] = [];
  let i = 0;
  for (let m = 1; m <= 6; m++) {
    for (let d = 1; d <= 12; d++) learned.push(bullet(m, d, i++));
  }
  return [
    "# Test Person",
    "",
    "- **Phone:** +15550100001",
    "",
    "## Who They Are",
    "A test subject with a big history file.",
    "",
    "## Our Dynamic",
    "Casual.",
    "",
    "## What I've Learned",
    ...learned,
    "",
    "## Open Items",
    "- **2026-07-01** — waiting on the thing",
    "",
    "## Shared History",
    bullet(2, 1, 900),
    bullet(7, 20, 901),
  ].join("\n");
}

describe("person-file archive size gate", () => {
  test("oversized file loses only its OLDEST bullets; nothing is deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "people-"));
    try {
      const body = bigPersonFile();
      expect(Buffer.byteLength(body)).toBeGreaterThan(ARCHIVE_TRIGGER_BYTES);
      writeFileSync(join(dir, "15550100001.md"), body);

      const r = archivePersonFile("15550100001.md", dir);
      expect(r).not.toBeNull();
      const live = readFileSync(join(dir, "15550100001.md"), "utf8");
      const archived = readFileSync(join(dir, "archive", "15550100001.md"), "utf8");

      // Live file back under target; identity sections untouched.
      expect(Buffer.byteLength(live)).toBeLessThanOrEqual(ARCHIVE_TARGET_BYTES + 200);
      expect(live).toContain("## Who They Are");
      expect(live).toContain("waiting on the thing"); // Open Items never archived
      // The newest bullets stay live; the oldest moved.
      expect(live).toContain("2026-06-12");
      expect(archived).toContain("2026-01-01");
      expect(live).not.toContain("2026-01-01");
      // Pointer note present so the model knows where history went.
      expect(live).toContain("older entries archived");
      // Zero loss: every dated entry exists in exactly one of the files.
      const count = (s: string) => (s.match(/^- \*\*2026-/gm) ?? []).length;
      expect(count(live) + count(archived)).toBe(count(body));
      // Recency floor honored per section.
      const liveLearned = (live.match(/entry \d+:/g) ?? []).length;
      expect(liveLearned).toBeGreaterThanOrEqual(KEEP_RECENT_BULLETS);

      // Second pass: now under trigger → no-op.
      expect(archivePersonFile("15550100001.md", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sweep skips small files entirely", () => {
    const dir = mkdtempSync(join(tmpdir(), "people-"));
    try {
      writeFileSync(join(dir, "small.md"), "# Small\n\n## Shared History\n- **2026-01-01** — hi");
      const r = sweepPersonArchives(dir);
      expect(r.files).toBe(0);
      expect(existsSync(join(dir, "archive", "small.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("undated content is never moved", () => {
    const dir = mkdtempSync(join(tmpdir(), "people-"));
    try {
      const prose = `## Shared History\n${"A long undated paragraph about them. ".repeat(400)}`;
      writeFileSync(join(dir, "p.md"), `# P\n\n${prose}`);
      // Oversized but with no dated bullets → nothing to archive.
      expect(archivePersonFile("p.md", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The KEEP_RECENT_BULLETS floor + TARGET constants are load-bearing for
  // the "never regress recall" constraint — pin them so a future tweak is
  // a conscious decision.
  test("gate constants", () => {
    expect(ARCHIVE_TRIGGER_BYTES).toBe(8 * 1024);
    expect(ARCHIVE_TARGET_BYTES).toBeLessThan(ARCHIVE_TRIGGER_BYTES);
    expect(KEEP_RECENT_BULLETS).toBeGreaterThanOrEqual(10);
  });
});

// ─── Chunk pruning ────────────────────────────────────────────────────

describe("refsWithPrefix + deleteRefs", () => {
  test("stale chunks and the legacy whole-file row get pruned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vec-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    const provider = new HashEmbedProvider();
    try {
      const r = await provider.embed(["a", "b", "c"]);
      const mk = (ref: string, i: number): IndexRow => ({
        ref,
        kind: "person-file",
        chatGuid: null,
        sender: null,
        ts: 1,
        text: "x",
        vec: normalize(r.vectors[i % 3]!),
        model: provider.model,
      });
      store.upsert([
        mk("person:p.md", 0), // legacy whole-file row
        mk("person:p.md#0", 1),
        mk("person:p.md#1", 2),
        mk("person:q.md#0", 0), // different doc — must survive
      ]);
      const live = new Set(["person:p.md#0"]);
      const stale = store.refsWithPrefix("person:p.md").filter((ref) => !live.has(ref));
      store.deleteRefs(stale);
      expect(store.hasRef("person:p.md#0")).toBe(true);
      expect(store.hasRef("person:p.md#1")).toBe(false);
      expect(store.hasRef("person:p.md")).toBe(false);
      expect(store.hasRef("person:q.md#0")).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Group files: indexing, content-dated ts, archive gate ────────────
// The user directive these protect: deep memory of old topics in a group
// chat or DM must stay reachable when naturally relevant. The model
// doesn't know what it doesn't see.

const chatDbStub = {
  query: () => ({
    all: () => [],
    get: () => ({ n: 0 }),
  }),
} as unknown as ChatDb;

const GROUP_GUID = "any;+;deadbeef00112233445566778899aabb";

function groupBody(): string {
  return [
    "# The Crew",
    "",
    `- **Chat GUID:** ${GROUP_GUID}`,
    "- **First seen:** 2026-03-01",
    "",
    "## Who's In It",
    "- **2026-03-01** — Alice, Bob and Carol; Carol runs the calendar and keeps everyone honest about plans.",
    "",
    "## Group Dynamic",
    "- **2026-03-05** — The group plans a quarterly barbecue at the lake house with assigned side dishes for everyone.",
    "",
    "## Shared History",
    "- **2026-04-10** — Bob's boat engine died mid-lake and Alice towed everyone back with the pontoon.",
    "",
  ].join("\n");
}

describe("group-file indexing", () => {
  test("chunks carry the group's chat guid and CONTENT dates, not mtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "groups-"));
    const groupsDir = join(root, "groups");
    mkdirSync(join(groupsDir, "archive"), { recursive: true });
    writeFileSync(join(groupsDir, "any-deadbeef.md"), groupBody());
    // Archive sibling has NO scaffold guid line — must inherit the live one.
    writeFileSync(
      join(groupsDir, "archive", "any-deadbeef.md"),
      [
        "# The Crew — archived history",
        "",
        "## Shared History (archived 2026-07-01)",
        "- **2026-03-20** — The infamous karaoke night where Bob sang the whole Shrek soundtrack from memory.",
        "",
      ].join("\n"),
    );
    const store = new VectorStore(join(root, "v.sqlite"));
    const provider = new HashEmbedProvider("hash", 32);
    store.resetIfModelChanged("hash", 32);
    const indexer = new Indexer(
      chatDbStub,
      store,
      provider,
      { maxChars: 2000, minChars: 1, batchSize: 64, chunkSize: 500, backfillDays: 0 },
      undefined,
      undefined,
      groupsDir,
    );
    try {
      const t = await indexer.tick();
      expect(t.people).toBeGreaterThan(0); // groups ride the people counter

      const q = normalize((await provider.embed(["karaoke night Shrek soundtrack"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "this-chat", chatGuid: GROUP_GUID },
        rowKinds: ["person-file"],
        limit: 10,
        minScore: -1,
      });
      // Live chunks scoped to the guid parsed from the scaffold line.
      expect(hits.some((h) => h.ref.startsWith("group:any-deadbeef.md#"))).toBe(true);
      // Archive chunks inherit the LIVE sibling's guid (they lack the line).
      const archived = hits.find((h) => h.ref.startsWith("group:archive/any-deadbeef.md#"));
      expect(archived).toBeDefined();
      // ts = newest dated bullet in the chunk — NOT today's mtime. A
      // freshly-swept archive must not look "recent" to recall windows.
      expect(archived!.ts).toBe(Date.parse("2026-03-20T12:00:00"));
      expect(archived!.ts).toBeLessThan(Date.now() - 30 * 86_400_000);
      const dynamic = hits.find((h) => h.text.includes("quarterly barbecue"));
      expect(dynamic!.ts).toBe(Date.parse("2026-03-05T12:00:00"));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("person-file chunks also use content dates over mtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "people-ts-"));
    const peopleDir = join(root, "people");
    mkdirSync(peopleDir, { recursive: true });
    writeFileSync(
      join(peopleDir, "15550100001.md"),
      "# Pat\n\n## Shared History\n- **2026-02-14** — Took the ferry to the island and got stuck overnight in the fog with no charger.\n",
    );
    const store = new VectorStore(join(root, "v.sqlite"));
    const provider = new HashEmbedProvider("hash", 32);
    store.resetIfModelChanged("hash", 32);
    const indexer = new Indexer(
      chatDbStub,
      store,
      provider,
      { maxChars: 2000, minChars: 1, batchSize: 64, chunkSize: 500, backfillDays: 0 },
      peopleDir,
    );
    try {
      await indexer.tick();
      const q = normalize((await provider.embed(["ferry island fog"])).vectors[0]!);
      // Stub chat.db has no chats → guid falls back to the bridge
      // convention `any;-;<handle>` (NOT a fabricated iMessage;-; guid,
      // which live sessions never query).
      const hits = store.search(q, {
        scope: { kind: "this-chat", chatGuid: "any;-;+15550100001" },
        rowKinds: ["person-file"],
        limit: 5,
        minScore: -1,
      });
      const hit = hits.find((h) => h.text.includes("ferry"));
      expect(hit!.ts).toBe(Date.parse("2026-02-14T12:00:00"));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("group-file archive size gate", () => {
  test("Group Dynamic + Shared History archive; core sections never move", () => {
    const dir = mkdtempSync(join(tmpdir(), "groups-arch-"));
    try {
      const bullet = (month: string, day: number, s: string) =>
        `- **2026-${month}-${String(day).padStart(2, "0")}** — ${s} ${"and plenty of extra words to give each line realistic weight in bytes".repeat(2)}`;
      const many = (month: string, s: string) =>
        Array.from({ length: 40 }, (_, i) => bullet(month, (i % 28) + 1, `${s} ${i}`)).join("\n");
      const body = [
        "# The Crew",
        "",
        `- **Chat GUID:** ${GROUP_GUID}`,
        "",
        "## Who's In It",
        bullet("01", 5, "Alice joined and immediately took over meal planning"),
        "",
        "## Group Dynamic",
        many("02", "dynamic observation"),
        "",
        "## Recurring Topics",
        bullet("03", 9, "the lake house maintenance schedule"),
        "",
        "## Open Items",
        bullet("04", 2, "waiting on the dock permit"),
        "",
        "## Shared History",
        many("05", "history event"),
        "",
      ].join("\n");
      expect(Buffer.byteLength(body)).toBeGreaterThan(ARCHIVE_TRIGGER_BYTES);
      writeFileSync(join(dir, "any-deadbeef.md"), body);

      const r = archiveGroupFile("any-deadbeef.md", dir);
      expect(r).not.toBeNull();
      const live = readFileSync(join(dir, "any-deadbeef.md"), "utf8");
      const archived = readFileSync(join(dir, "archive", "any-deadbeef.md"), "utf8");

      // Core sections stay whole.
      expect(live).toContain("meal planning");
      expect(live).toContain("lake house maintenance");
      expect(live).toContain("dock permit");
      // History sections shed their oldest; zero loss overall.
      expect(archived).toContain("dynamic observation");
      expect(archived).toContain("history event");
      const count = (s: string) => (s.match(/^- \*\*2026-/gm) ?? []).length;
      expect(count(live) + count(archived)).toBe(count(body));

      // Sweep wrapper picks it up too (idempotent second pass).
      expect(sweepGroupArchives(dir).files).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auto-recall live-profile exclusion", () => {
  test("live group chunks are filtered; archived group chunks surface", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-group-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    const provider = new HashEmbedProvider();
    try {
      const texts = [
        "The Crew > Shared History\n- **2026-03-20** — karaoke night where Bob sang Shrek",
        "The Crew > Shared History\n- **2026-03-21** — karaoke rematch where Bob lost his voice",
      ];
      const r = await provider.embed(texts);
      const old = Date.parse("2026-03-20T12:00:00");
      store.upsert([
        {
          ref: "group:any-x.md#3",
          kind: "person-file",
          chatGuid: GROUP_GUID,
          sender: null,
          ts: old,
          text: texts[0]!,
          vec: normalize(r.vectors[0]!),
          model: provider.model,
        },
        {
          ref: "group:archive/any-x.md#0",
          kind: "person-file",
          chatGuid: GROUP_GUID,
          sender: null,
          ts: old,
          text: texts[1]!,
          vec: normalize(r.vectors[1]!),
          model: provider.model,
        },
      ]);
      const res = await autoRecall("karaoke night Bob", provider, store, {
        chatGuid: GROUP_GUID,
        limit: 10,
        minScore: -1,
        excludeRecentMs: 0,
      });
      const refs = [...res.recent, ...res.deep].map((h) => h.ref);
      expect(refs).toContain("group:archive/any-x.md#0");
      // Live group chunk is already in the group session's system prompt.
      expect(refs).not.toContain("group:any-x.md#3");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
