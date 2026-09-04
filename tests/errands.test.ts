/**
 * Concierge errands: tracked round-trip asks. ask_contact relays with a
 * report-back contract, report_errand closes the loop into the asker's
 * session, follow-up crons chase silence and die on answer/cancel.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrandStore } from "../src/concierge/errands.ts";
import type { Config } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { errandTools } from "../src/mcp/tools/errands.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

const JORDAN = "+15550100001";
const MOM = "+15550100003";
const JORDAN_KEY = `imessage:dm:${JORDAN}`;
const MOM_KEY = `imessage:dm:${MOM}`;

function buildFakeChatDb(handles: string[]): ChatDb {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  `);
  for (const h of handles) db.query("INSERT INTO handle(id) VALUES (?)").run(h);
  return {
    query: <T = unknown>(sql: string) =>
      db.query(sql) as unknown as {
        all: (...p: unknown[]) => T[];
        get: (...p: unknown[]) => T | undefined;
      },
  } as unknown as ChatDb;
}

function makeCtx(sessionKey: string, dataDir: string, crons: CronStore): ToolContext {
  return {
    config: { outbound: { mode: "*" } } as unknown as Config,
    cron: crons,
    chatDb: buildFakeChatDb([JORDAN, MOM]),
    contacts: new ContactBook([]),
    sessionKey,
    dataDir,
  } as unknown as ToolContext;
}

function callTool(ctx: ToolContext, name: string, args: unknown) {
  const tools = errandTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(tool.inputSchema.parse(args));
}

function textOf(result: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return (result as any).content.map((c: any) => c.text).join("\n");
}

describe("errands", () => {
  let dataDir: string;
  let crons: CronStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "errands-"));
    crons = new CronStore(dataDir);
  });

  afterEach(() => {
    crons.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function askMom(): Promise<string> {
    const hunterCtx = makeCtx(JORDAN_KEY, dataDir, crons);
    const res = await callTool(hunterCtx, "ask_contact", {
      question: "Does Saturday work for dinner?",
      is_group_chat: false,
      phone_number: MOM,
      follow_up_after_hours: 4,
    });
    const text = textOf(res);
    const id = text.match(/errand (err_\S+) sent/)?.[1];
    if (!id) throw new Error(`no errand id in: ${text}`);
    return id;
  }

  test("ask_contact creates the errand, the tracked relay, and a follow-up cron", async () => {
    const id = await askMom();

    const store = new ErrandStore(dataDir);
    const errand = store.get(id);
    expect(errand?.status).toBe("active");
    expect(errand?.originatorSession).toBe(JORDAN_KEY);
    expect(errand?.targetSession).toBe(MOM_KEY);

    // Relay cron into Mom's session carries the report-back contract.
    const momJobs = crons.listActive(MOM_KEY);
    expect(momJobs.length).toBe(1);
    expect(momJobs[0]!.systemEvent).toContain("Does Saturday work for dinner?");
    expect(momJobs[0]!.systemEvent).toContain(`errand ${id}`);
    expect(momJobs[0]!.systemEvent).toContain("report_errand");

    // Follow-up cron in Jordan's session, ~4h out.
    const hunterJobs = crons.listActive(JORDAN_KEY);
    expect(hunterJobs.length).toBe(1);
    expect(hunterJobs[0]!.systemEvent).toContain(`[Errand follow-up ${id}]`);
    expect(hunterJobs[0]!.id).toBe(errand!.followupCronId!);
    const eta = hunterJobs[0]!.nextFireMs - Date.now();
    expect(eta).toBeGreaterThan(3.9 * 3_600_000);
    expect(eta).toBeLessThan(4.1 * 3_600_000);
  });

  test("report_errand closes the loop: answer event fires into the asker, follow-up dies", async () => {
    const id = await askMom();
    const momCtx = makeCtx(MOM_KEY, dataDir, crons);

    const res = await callTool(momCtx, "report_errand", {
      errand_id: id,
      answer: "Saturday works, she'll bring dessert",
    });
    expect(textOf(res)).toContain("closed");

    const store = new ErrandStore(dataDir);
    expect(store.get(id)?.status).toBe("answered");

    const hunterJobs = crons.listActive(JORDAN_KEY);
    const followups = hunterJobs.filter((j) => j.systemEvent.includes("follow-up"));
    const answers = hunterJobs.filter((j) => j.systemEvent.includes(`[Errand answered ${id}]`));
    expect(followups.length).toBe(0);
    expect(answers.length).toBe(1);
    expect(answers[0]!.systemEvent).toContain("Saturday works, she'll bring dessert");

    // Double-report is rejected.
    const again = await callTool(momCtx, "report_errand", { errand_id: id, answer: "x" });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((again as any).isError).toBe(true);
  });

  test("report_errand enforces the assigned session", async () => {
    const id = await askMom();
    const strangerCtx = makeCtx("imessage:dm:+15555550000", dataDir, crons);
    const res = await callTool(strangerCtx, "report_errand", { errand_id: id, answer: "nope" });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((res as any).isError).toBe(true);
    expect(textOf(res)).toContain("isn't assigned to this chat");
  });

  test("cancel_errand is originator-only, kills the follow-up, and reporting after is a soft no-op", async () => {
    const id = await askMom();
    const hunterCtx = makeCtx(JORDAN_KEY, dataDir, crons);
    const momCtx = makeCtx(MOM_KEY, dataDir, crons);

    const notMine = await callTool(momCtx, "cancel_errand", { errand_id: id });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((notMine as any).isError).toBe(true);

    const canceled = await callTool(hunterCtx, "cancel_errand", { errand_id: id });
    expect(textOf(canceled)).toContain("canceled");
    expect(
      crons.listActive(JORDAN_KEY).filter((j) => j.systemEvent.includes("follow-up")).length,
    ).toBe(0);

    const report = await callTool(momCtx, "report_errand", { errand_id: id, answer: "yes" });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((report as any).isError).toBeFalsy();
    expect(textOf(report)).toContain("no report needed");
    // No answer event was fired into Jordan's session.
    expect(
      crons.listActive(JORDAN_KEY).filter((j) => j.systemEvent.includes("Errand answered")).length,
    ).toBe(0);
  });

  test("list_errands shows both directions and ask_contact is blocked from group sessions", async () => {
    const id = await askMom();
    const hunterCtx = makeCtx(JORDAN_KEY, dataDir, crons);
    const momCtx = makeCtx(MOM_KEY, dataDir, crons);

    const sentView = textOf(await callTool(hunterCtx, "list_errands", {}));
    expect(sentView).toContain("Asks you sent:");
    expect(sentView).toContain(id);
    expect(sentView).toContain("awaiting answer");

    const owedView = textOf(await callTool(momCtx, "list_errands", {}));
    expect(owedView).toContain("you owe an answer");
    expect(owedView).toContain("Does Saturday work for dinner?");

    const groupCtx = makeCtx("imessage:group:chat-xyz", dataDir, crons);
    const blocked = await callTool(groupCtx, "ask_contact", {
      question: "q",
      is_group_chat: false,
      phone_number: MOM,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((blocked as any).isError).toBe(true);
  });
});
