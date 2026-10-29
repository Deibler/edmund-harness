/**
 * An archive only ever gains a section at its end, yet every append used to
 * re-embed the whole file: 300-650 chunks for the largest, 10-28k chunks a
 * day, on the one worker live recall queries wait behind (2026-10-29). The
 * indexer now embeds only text it does not already hold for the document.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { Indexer } from "../src/memory/indexer.ts";
import { VectorStore, normalize } from "../src/memory/vector-store.ts";

const chatDbStub = {
  query: () => ({ all: () => [], get: () => ({ n: 0 }) }),
} as unknown as ChatDb;

class CountingProvider extends HashEmbedProvider {
  embedded = 0;
  override async embed(texts: string[]) {
    this.embedded += texts.length;
    return super.embed(texts);
  }
}

const section = (n: number, topic: string) =>
  `## Shared History (archived 2026-10-${String(n).padStart(2, "0")})\n- **2026-10-${String(n).padStart(2, "0")}** — ${topic} ${"detail ".repeat(160)}\n`;

let clock = Date.now() / 1000;
const touch = (path: string) => {
  clock += 10;
  utimesSync(path, clock, clock);
};

describe("re-indexing a person archive", () => {
  test("embeds only the new section, and moved sections stay findable", async () => {
    const root = mkdtempSync(join(tmpdir(), "chunk-reuse-"));
    const people = join(root, "people");
    mkdirSync(join(people, "archive"), { recursive: true });
    const archive = join(people, "archive", "15550100061.md");
    writeFileSync(
      archive,
      `# Pat — archived history\n\n${section(1, "ferry island fog")}${section(2, "pickleball saturday")}${section(3, "turkey feathers orange")}`,
    );
    touch(archive);
    const store = new VectorStore(join(root, "v.sqlite"));
    const provider = new CountingProvider("hash", 64);
    store.resetIfModelChanged("hash", 64);
    const indexer = new Indexer(
      chatDbStub,
      store,
      provider,
      { maxChars: 2000, minChars: 1, batchSize: 8, chunkSize: 500, backfillDays: 0 },
      people,
    );
    try {
      await indexer.tick();
      const first = provider.embedded;
      expect(first).toBeGreaterThanOrEqual(3);

      appendFileSync(archive, section(4, "pull station clear led"));
      touch(archive);
      provider.embedded = 0;
      await indexer.tick();
      expect(provider.embedded).toBe(1);

      // A section inserted near the top shifts every later chunk's position.
      const body = await Bun.file(archive).text();
      writeFileSync(archive, body.replace("\n\n", `\n\n${section(9, "crockpot kielbasa")}`));
      touch(archive);
      provider.embedded = 0;
      await indexer.tick();
      expect(provider.embedded).toBe(1);

      const q = normalize((await provider.embed(["turkey feathers orange"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        rowKinds: ["person-file"],
        limit: 10,
        minScore: -1,
      });
      expect(hits.filter((h) => h.text.includes("turkey feathers orange"))).toHaveLength(1);
      expect(store.rowsWithPrefix("person:archive/15550100061.md#")).toHaveLength(5);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
