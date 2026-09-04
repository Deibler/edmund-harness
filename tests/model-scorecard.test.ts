import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelScorecard, recordModelOutcome } from "../src/media/model-scorecard.ts";

describe("model-scorecard", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "edmund-scorecard-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("empty store returns no rows", () => {
    expect(modelScorecard({ dataDir })).toEqual([]);
  });

  test("aggregates outcomes per (kind, model)", () => {
    recordModelOutcome({ dataDir, kind: "image", model: "good", outcome: "generated" });
    recordModelOutcome({ dataDir, kind: "image", model: "good", outcome: "generated" });
    recordModelOutcome({ dataDir, kind: "image", model: "good", outcome: "liked" });
    recordModelOutcome({ dataDir, kind: "image", model: "bad", outcome: "failed" });
    recordModelOutcome({ dataDir, kind: "image", model: "bad", outcome: "rejected" });

    const stats = modelScorecard({ dataDir, kind: "image" });
    const good = stats.find((s) => s.model === "good")!;
    const bad = stats.find((s) => s.model === "bad")!;

    expect(good.generated).toBe(2);
    expect(good.liked).toBe(1);
    expect(good.successRate).toBe(1);
    expect(good.approval).toBe(1);

    expect(bad.failed).toBe(1);
    expect(bad.rejected).toBe(1);
    expect(bad.successRate).toBe(0);
    expect(bad.approval).toBe(0);
  });

  test("ranks the better-performing model first", () => {
    for (let i = 0; i < 5; i++) {
      recordModelOutcome({ dataDir, kind: "image", model: "good", outcome: "generated" });
      recordModelOutcome({ dataDir, kind: "image", model: "good", outcome: "liked" });
    }
    for (let i = 0; i < 5; i++) {
      recordModelOutcome({ dataDir, kind: "image", model: "bad", outcome: "failed" });
      recordModelOutcome({ dataDir, kind: "image", model: "bad", outcome: "rejected" });
    }
    const stats = modelScorecard({ dataDir, kind: "image" });
    expect(stats[0]!.model).toBe("good");
    expect(stats[0]!.score).toBeGreaterThan(stats[1]!.score);
  });

  test("approval is null until any sentiment is recorded", () => {
    recordModelOutcome({ dataDir, kind: "video", model: "untried", outcome: "generated" });
    const [stat] = modelScorecard({ dataDir, kind: "video" });
    expect(stat!.approval).toBeNull();
  });

  test("kind filter isolates modalities", () => {
    recordModelOutcome({ dataDir, kind: "image", model: "m", outcome: "generated" });
    recordModelOutcome({ dataDir, kind: "video", model: "m", outcome: "failed" });
    expect(modelScorecard({ dataDir, kind: "image" })).toHaveLength(1);
    expect(modelScorecard({ dataDir, kind: "video" })).toHaveLength(1);
    expect(modelScorecard({ dataDir })).toHaveLength(2);
  });
});
