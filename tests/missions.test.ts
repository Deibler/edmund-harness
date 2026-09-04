/**
 * Standing missions: cron-backed watchers with a notes file and a
 * speak-only-on-condition contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/cron/store.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { buildMissionEvent, missionTools, parseMissionSlug } from "../src/mcp/tools/missions.ts";

const KEY = "imessage:dm:+15550100001";

function callTool(tools: ReturnType<typeof missionTools>, name: string, args: unknown) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(tool.inputSchema.parse(args));
}

function textOf(result: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return (result as any).content.map((c: any) => c.text).join("\n");
}

describe("missions", () => {
  let root: string;
  let crons: CronStore;
  let ctx: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "missions-"));
    crons = new CronStore(root);
    ctx = {
      cron: crons,
      sessionKey: KEY,
      sandboxPath: join(root, "sandbox"),
    } as unknown as ToolContext;
  });

  afterEach(() => {
    crons.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("start_mission creates a recurring cron with the mission contract and a notes file", async () => {
    const res = await callTool(missionTools(ctx), "start_mission", {
      name: "eBay reel watch",
      objective: "Tell Jordan if the Shimano reel drops under $200.",
      check_instructions: "web_fetch the listing URL in the notes file; compare price.",
      cadence: "0 9,17 * * *",
      report_when: "price < $200 or listing gone",
    });
    expect(textOf(res)).toContain("mission 'ebay-reel-watch' started");

    const jobs = crons.listActive(KEY);
    expect(jobs.length).toBe(1);
    const event = jobs[0]!.systemEvent;
    expect(parseMissionSlug(event)).toBe("ebay-reel-watch");
    expect(event).toContain("Objective: Tell Jordan if the Shimano reel drops under $200.");
    expect(event).toContain("output NOTHING");
    expect(event).toContain('end_mission(slug: "ebay-reel-watch"');
    expect(jobs[0]!.schedule.kind).toBe("cron");
    expect(jobs[0]!.gracePeriodMs).toBe(60 * 60 * 1000);

    const notes = readFileSync(join(ctx.sandboxPath, "missions", "ebay-reel-watch.md"), "utf8");
    expect(notes).toContain("# Mission: eBay reel watch");
    expect(notes).toContain("## Check log");
  });

  test("duplicate slug is rejected while active", async () => {
    const tools = missionTools(ctx);
    await callTool(tools, "start_mission", {
      name: "Score Watch",
      objective: "o",
      check_instructions: "c",
      cadence: "0 * * * *",
      report_when: "r",
    });
    const dup = await callTool(tools, "start_mission", {
      name: "score watch!!",
      objective: "o2",
      check_instructions: "c2",
      cadence: "0 * * * *",
      report_when: "r2",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((dup as any).isError).toBe(true);
    expect(textOf(dup)).toContain("already running");
  });

  test("list_missions shows objective and end_mission cancels + journals", async () => {
    const tools = missionTools(ctx);
    await callTool(tools, "start_mission", {
      name: "flight watch",
      objective: "Ping when Riley's flight lands.",
      check_instructions: "check the flight API",
      cadence: "in 2 hours",
      report_when: "landed or delayed >30m",
    });

    const list = textOf(await callTool(tools, "list_missions", {}));
    expect(list).toContain("flight-watch");
    expect(list).toContain("Ping when Riley's flight lands.");

    const end = await callTool(tools, "end_mission", {
      slug: "flight-watch",
      resolution: "landed on time, told Jordan",
    });
    expect(textOf(end)).toContain("ended");
    expect(crons.listActive(KEY).length).toBe(0);
    const notes = readFileSync(join(ctx.sandboxPath, "missions", "flight-watch.md"), "utf8");
    expect(notes).toContain("## Resolved");
    expect(notes).toContain("landed on time");

    const empty = textOf(await callTool(tools, "list_missions", {}));
    expect(empty).toBe("no standing missions");
  });

  test("end_mission on unknown slug errors; missions don't collide with plain reminders", async () => {
    crons.create({
      sessionKey: KEY,
      systemEvent: "Reminder: stand up",
      schedule: { kind: "once", atMs: Date.now() + 60_000 },
      gracePeriodMs: null,
    });
    const tools = missionTools(ctx);
    const list = textOf(await callTool(tools, "list_missions", {}));
    expect(list).toBe("no standing missions");
    const end = await callTool(tools, "end_mission", { slug: "nope", resolution: "x" });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((end as any).isError).toBe(true);
    // The plain reminder survives.
    expect(crons.listActive(KEY).length).toBe(1);
  });

  test("buildMissionEvent slug round-trips through parseMissionSlug", () => {
    const ev = buildMissionEvent({
      slug: "a-b-c",
      name: "n",
      objective: "o",
      checkInstructions: "ci",
      reportWhen: "rw",
      wrapUpBy: "2026-06-20",
      notesPath: "/tmp/x.md",
    });
    expect(parseMissionSlug(ev)).toBe("a-b-c");
    expect(ev).toContain("Wrap up by: 2026-06-20");
    expect(parseMissionSlug("Reminder: stand up")).toBeNull();
  });
});
