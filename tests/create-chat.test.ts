import { afterEach, expect, mock, test } from "bun:test";

import { ConfigSchema } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";

// IMCore mints a new chat on this Mac only. Nobody else sees it until a message
// goes out, so a create that sent nothing used to report "created chat" for a
// group that existed on no one's phone. The first message is now required, and
// the result names the chat it went to so the model can address it later.

const succeed = (op: string): Promise<unknown> =>
  Promise.resolve(op === "createChat" ? { guid: "any;+;chat0001", isNew: true } : { guid: "M1" });
const invoke = mock(succeed);
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

const { imessageActionTools } = await import("../src/mcp/tools/imessage-actions.ts");

afterEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(succeed);
});

const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  paths: { chat_db: "/nonexistent/never/chat.db" },
  imessage_actions: { create_chat: true },
});

function createChatTool() {
  const ctx = {
    config,
    sessionKey: "dm:+15551230001",
    chatGuids: [],
    guestTier: null,
    sessionTier: "operator",
  } as unknown as ToolContext;
  const def = imessageActionTools(ctx).find((t) => t.name === "create_chat");
  if (!def) throw new Error("create_chat not registered");
  return def;
}

test("a create with no first message is rejected by the schema", () => {
  const def = createChatTool();
  const parsed = def.inputSchema.safeParse({ handles: ["+15551230002", "+15551230003"] });
  expect(parsed.success).toBe(false);
});

test("the first message goes to the chat that was created, and the result names it", async () => {
  const def = createChatTool();
  const res = await def.handler({
    handles: ["+15551230002", "+15551230003"],
    name: "Plans",
    text: "hey all",
  });

  expect(res.isError).toBeFalsy();
  expect(String(res.content[0]!.text)).toContain("any;+;chat0001");
  const ops = (invoke.mock.calls as unknown as [string, Record<string, unknown>][]).map(
    ([op, args]) => [op, op === "send" ? args.chat : args.handles],
  );
  expect(ops[0]).toEqual(["createChat", ["+15551230002", "+15551230003"]]);
  expect(ops[1]![0]).toBe("send");
  expect(String(ops[1]![1])).toContain("any;+;chat0001");
});

test("a first message that fails to send is reported as a failure", async () => {
  invoke.mockImplementation((op: string) =>
    op === "createChat"
      ? Promise.resolve({ guid: "any;+;chat0001" })
      : Promise.reject(Object.assign(new Error("no chat"), { code: "chat_not_found" })),
  );
  const def = createChatTool();
  const res = await def.handler({ handles: ["+15551230002", "+15551230003"], text: "hey all" });
  expect(res.isError).toBe(true);
});

test("the tool is not offered while the operator has it switched off", () => {
  const off = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    paths: { chat_db: "/nonexistent/never/chat.db" },
  });
  const ctx = {
    config: off,
    sessionKey: "dm:+15551230001",
    chatGuids: [],
    guestTier: null,
    sessionTier: "operator",
  } as unknown as ToolContext;
  expect(imessageActionTools(ctx).map((t) => t.name)).not.toContain("create_chat");
});
