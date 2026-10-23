/**
 * A scheduled event's envelope states its times the way every inbound
 * message does, in the home zone. They were UTC ISO strings, so a reminder
 * firing after 8pm Eastern carried tomorrow's date.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduledEventHeader } from "../src/cron/fire.ts";

describe("scheduledEventHeader", () => {
  test("an evening fire keeps its own date", () => {
    // 2026-10-23 21:30 EDT is 2026-10-24 01:30 UTC.
    const at = Date.UTC(2026, 9, 24, 1, 30);
    const h = scheduledEventHeader(at, at + 60_000, "");
    expect(h).toBe(
      "[Scheduled event · scheduled=Fri 2026-10-23 21:30 EDT fired=Fri 2026-10-23 21:31 EDT]",
    );
    expect(h).not.toContain("Z");
  });

  test("the fired envelope uses it", () => {
    const fire = readFileSync(join(import.meta.dir, "../src/cron/fire.ts"), "utf8");
    expect(fire).toContain("scheduledEventHeader(job.nextFireMs, now, latenessNote),");
    expect(fire).not.toContain("fired=${new Date(now).toISOString()}");
  });
});
