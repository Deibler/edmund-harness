/**
 * A reaction reaches the message it was meant for, as a reaction a phone can
 * show, or the tool says it did not.
 *
 * On 2026-11-25 the assistant was asked to acknowledge with a tapback. The
 * system prompt listed the tool as `react(target_msg_guid, reaction)` with
 * "heart/thumbs/laugh". The tool has no `target_msg_guid` and no `thumbs`:
 * the id was dropped, so the reaction went to the newest message, and
 * "thumbs" went out as an emoji reaction whose emoji was the word, which was
 * never delivered. Both calls answered "reacted". Over the month before, 10
 * of 20 `react` calls used that argument name and 2 used that word.
 *
 * The bridge is mocked: nothing here reaches Messages.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { ConfigSchema } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import type { ToolDef } from "../src/mcp/tools/types.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const invoke = mock((): Promise<unknown> => Promise.resolve({}));
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

const { isSingleEmoji, sendTapback } = await import("../src/imessage/actions/reactions.ts");
const { findReplyTarget, messageTools, resolveReaction } = await import(
  "../src/mcp/tools/message.ts"
);
const { callTool, normalizeAliases, unknownArguments } = await import("../src/mcp/server.ts");

const HERE = "any;-;+15550100041";
const ELSEWHERE = "any;-;+15550100042";
const id = (n: number) => `AAAAAAAA-0000-4000-8000-00000000000${n}`;
const SWEET = id(1);
const QUESTION = id(2);
const THEIR_TAPBACK = id(3);
const OTHER_CHAT = id(4);

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${HERE}', '+15550100041')`);
  w.exec(
    `INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (2, '${ELSEWHERE}', '+15550100042')`,
  );
  const add = (row: number, chat: number, guid: string, text: string, type: number, of = "") => {
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type, associated_message_guid)
       VALUES (${row}, '${guid}', '${text}', 1, 0, ${row * 1000}, ${type}, ${of ? `'p:0/${of}'` : "NULL"})`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (${chat}, ${row})`);
  };
  add(1, 1, SWEET, "Sweet", 0);
  add(2, 1, QUESTION, "Did you respond to me?", 0);
  // The newest row in the chat is the other person's own tapback.
  add(3, 1, THEIR_TAPBACK, "Liked an earlier message", 2001, QUESTION);
  add(4, 2, OTHER_CHAT, "a message in another conversation", 0);
  w.close();
}
const chatDb = new ChatDb(db.path);
afterAll(() => {
  chatDb.close();
  db.cleanup();
});
afterEach(() => invoke.mockClear());

const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const ctx = {
  config,
  chatDb,
  sessionKey: "imessage:dm:+15550100041",
  chatGuids: [HERE],
  sandboxPath: "/nonexistent",
  dataDir: "/nonexistent",
  guestTier: null,
  sessionTier: "operator",
} as unknown as ToolContext;

const tools = new Map<string, ToolDef>(messageTools(ctx).map((t: ToolDef) => [t.name, t]));
const react = (args: Record<string, unknown>) => callTool(tools, "react", args);
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
/** What the bridge was asked to do, if it was asked. */
const sent = () => invoke.mock.calls.map((c) => (c as unknown[])[1] as Record<string, unknown>);

describe("what counts as a reaction", () => {
  test("the six words, the names the model reaches for, and one emoji", () => {
    for (const word of ["love", "like", "dislike", "laugh", "emphasis", "question"]) {
      expect(resolveReaction(word)).toBe(word);
    }
    expect(resolveReaction(" Heart ")).toBe("love");
    expect(resolveReaction("thumbs")).toBe("like");
    expect(resolveReaction("👍")).toBe("like");
    expect(resolveReaction("emphasize")).toBe("emphasis");
    expect(resolveReaction("🔥")).toBe("🔥");
  });

  test("any other word is not one", () => {
    for (const word of ["thumbz", "great", "ok", "seen", "🔥🔥", "nice 👍", ""]) {
      expect(resolveReaction(word)).toBeNull();
    }
  });

  test("one emoji is one grapheme, however many code points", () => {
    for (const emoji of ["👍", "❤️", "👍🏽", "🇺🇸", "👨‍👩‍👧", "1️⃣", "‼️"]) {
      expect(isSingleEmoji(emoji)).toBe(true);
    }
    for (const not of ["thumbs", "a", "7", "", "🔥🔥", "ok👍", "?"]) {
      expect(isSingleEmoji(not)).toBe(false);
    }
  });
});

describe("the react tool", () => {
  test("refuses a word that is not a reaction before anything is sent", async () => {
    const r = await react({ reaction: "thumbz" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"thumbz" is not a reaction, so nothing was sent');
    expect(text(r)).toContain("love, like, dislike, laugh, emphasis, question");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("sends `thumbs`, which the prompt used to teach, as like", async () => {
    const r = await react({ reaction: "thumbs", target_guid: SWEET });
    expect(r.isError).toBeFalsy();
    expect(sent()).toEqual([{ chat: HERE, message: SWEET, kind: "like" }]);
  });

  test("takes the message id under the name the prompt used to give it", async () => {
    const r = await react({ reaction: "like", target_msg_guid: SWEET });
    expect(sent()[0]!.message).toBe(SWEET);
    expect(text(r)).toBe('reacted like to their message "Sweet"');
  });

  test("with no target, reacts to the newest message, never to someone's tapback", async () => {
    const r = await react({ reaction: "love" });
    expect(sent()[0]!.message).toBe(QUESTION);
    expect(sent()[0]!.message).not.toBe(THEIR_TAPBACK);
    expect(text(r)).toBe('reacted love to their message "Did you respond to me?"');
  });

  test("says which message it landed on when one is named by its words", async () => {
    const r = await react({ reaction: "laugh", target: "sweet" });
    expect(sent()[0]!.message).toBe(SWEET);
    expect(text(r)).toBe('reacted laugh to their message "Sweet"');
  });

  test("refuses an argument it does not have, and does nothing", async () => {
    const r = await react({ reaction: "like", message_id: SWEET });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("react has no argument `message_id`, so nothing was done");
    expect(text(r)).toContain("It takes: reaction, target?, target_guid?");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("sendTapback", () => {
  test("never sends a word as if it were an emoji", async () => {
    const r = await sendTapback({ chatGuid: HERE, messageGuid: SWEET, kind: "thumbz" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"thumbz" is not a reaction');
    expect(invoke).not.toHaveBeenCalled();
  });

  test("sends an emoji as an emoji and a word as its kind", async () => {
    await sendTapback({ chatGuid: HERE, messageGuid: SWEET, kind: "🔥" });
    await sendTapback({ chatGuid: HERE, messageGuid: SWEET, kind: "emphasis" });
    expect(sent()).toEqual([
      { chat: HERE, message: SWEET, kind: "emoji", emoji: "🔥" },
      { chat: HERE, message: SWEET, kind: "emphasize" },
    ]);
  });
});

describe("an argument the tool does not have", () => {
  const schema = z.object({ id: z.string(), note: z.string().optional() });
  const ran: unknown[] = [];
  const fake = new Map<string, ToolDef>([
    [
      "fake",
      {
        name: "fake",
        description: "",
        inputSchema: schema,
        handler: (args) => {
          ran.push(args);
          return { content: [{ type: "text", text: "ran" }] };
        },
      },
    ],
  ]);

  test("stops the call before the tool runs, and names what the tool takes", async () => {
    ran.length = 0;
    const r = await callTool(fake, "fake", { id: "a", nite: "typo" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      "error: fake has no argument `nite`, so nothing was done. It takes: id, note?.",
    );
    expect(ran).toEqual([]);
    expect(text(await callTool(fake, "fake", { id: "a", note: "ok" }))).toBe("ran");
    expect(ran).toEqual([{ id: "a", note: "ok" }]);
  });

  test("is found through a refinement, and not looked for where any key is allowed", () => {
    expect(unknownArguments({ id: "a", x: 1 }, schema)).toEqual(["x"]);
    expect(
      unknownArguments(
        { id: "a", x: 1 },
        schema.superRefine(() => {}),
      ),
    ).toEqual(["x"]);
    expect(unknownArguments({ id: "a", x: 1 }, schema.passthrough())).toEqual([]);
    expect(unknownArguments({ id: "a", x: 1 }, schema.catchall(z.number()))).toEqual([]);
    expect(unknownArguments({ a: 1 }, z.union([z.object({ a: z.number() }), z.string()]))).toEqual(
      [],
    );
  });

  test("a field given as null was not given", () => {
    expect(unknownArguments({ id: "a", x: null, y: undefined }, schema)).toEqual([]);
  });

  test("the names seen in the log are read as the argument they meant", () => {
    expect(normalizeAliases({ agent_id: "agent_1" }, schema)).toEqual({ id: "agent_1" });
    // Never over a real argument, and never onto a tool that has no such field.
    expect(normalizeAliases({ agent_id: "x", id: "y" }, schema)).toEqual({
      agent_id: "x",
      id: "y",
    });
    expect(normalizeAliases({ agent_id: "x" }, z.object({ name: z.string() }))).toEqual({
      agent_id: "x",
    });
  });
});

describe("the message a reply names", () => {
  test("is found by its id, as the mid-turn note gives it", () => {
    expect(findReplyTarget(ctx, QUESTION)?.messageGuid).toBe(QUESTION);
    expect(findReplyTarget(ctx, ` ${QUESTION} `)?.text).toBe("Did you respond to me?");
  });

  test("is found by a few of its words", () => {
    expect(findReplyTarget(ctx, "respond to me")?.messageGuid).toBe(QUESTION);
  });

  test("is never a message in another conversation: the reply goes where the message is", () => {
    expect(findReplyTarget(ctx, OTHER_CHAT)).toBeNull();
    expect(findReplyTarget(ctx, "another conversation")).toBeNull();
  });
});
