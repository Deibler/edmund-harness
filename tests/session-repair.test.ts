import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairSessionToolIds, repairedToolId } from "../src/claude/session-repair.ts";

describe("repairSessionToolIds", () => {
  test("rewrites both sides of invalid tool pairs and keeps a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-repair-"));
    const path = join(dir, "session.jsonl");
    const invalidId = "mcp__edmund__semantic_search:0";
    const records = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: invalidId }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: invalidId }] } },
    ];
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    try {
      const result = repairSessionToolIds(path);
      expect(result).toMatchObject({ changed: true, toolUseIds: 1, toolResultIds: 1 });
      expect(existsSync(`${path}.pre-direct.bak`)).toBe(true);

      const [assistant, user] = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const repairedUse = assistant.message.content[0].id;
      const repairedResult = user.message.content[0].tool_use_id;
      expect(repairedUse).toBe(repairedResult);
      expect(repairedUse).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(repairedUse).toBe(repairedToolId(invalidId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves valid ids and malformed lines untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-repair-"));
    const path = join(dir, "session.jsonl");
    const original = [
      JSON.stringify({ message: { content: [{ type: "tool_use", id: "toolu_abc-123" }] } }),
      "not-json",
      "",
    ].join("\n");
    writeFileSync(path, original);

    try {
      expect(repairSessionToolIds(path)).toEqual({
        changed: false,
        toolUseIds: 0,
        toolResultIds: 0,
        backupPath: null,
      });
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
