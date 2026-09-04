import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import type { ImcoreBridge } from "imcore-bridge";

import { callBridgeControl } from "../src/imessage/bridge/control-client.ts";
import { serveBridgeControl } from "../src/imessage/bridge/control-server.ts";
import { ControlUnreachableError } from "../src/imessage/bridge/errors.ts";

// The daemon owns the only bridge, so a `claude -p` subprocess reaches Messages
// over the control socket. These cover that hop: the operation arrives with its
// arguments intact, results and typed errors come back, and every way the hop
// can fail surfaces as an error rather than as a send that silently did nothing.

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

function socketPath(): string {
  return join(fs.mkdtempSync(join(os.tmpdir(), "edmund-ctl-")), "control.sock");
}

/** A stand-in for the bridge, recording what the op layer asked it to do. */
function fakeBridge(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    };

  const bridge = {
    send: record("send", overrides.send ?? { guid: "GUID-1", service: "iMessage" }),
    sendStatus: record("sendStatus", { state: "delivered" }),
    setTyping: record("setTyping"),
    tapback: record("tapback"),
    edit: record("edit"),
    retract: record("retract"),
    deleteMessages: record("deleteMessages", { deleted: 1, requested: 1, matched: 1 }),
    markRead: record("markRead"),
    notifyAnyway: record("notifyAnyway"),
    setGroupPhoto: record("setGroupPhoto"),
    createChat: record("createChat", { guid: "chat1", isNew: true }),
    account: record("account", { account: "e:someone@icloud.com" }),
    status: record("status", { ready: true }),
    whois: record("whois", { id: "+15551234567", isIMessage: true }),
    group: {
      rename: record("group.rename", { changed: true }),
      addMembers: record("group.addMembers", { changed: true }),
      removeMembers: record("group.removeMembers", { changed: false }),
      leave: record("group.leave", { changed: true }),
    },
    ...overrides,
  };
  return { bridge: bridge as unknown as ImcoreBridge, calls };
}

async function serve(bridge: ImcoreBridge): Promise<string> {
  const path = socketPath();
  const server = await serveBridgeControl(path, { resolveBridge: () => bridge });
  cleanups.push(() => server.close());
  return path;
}

test("a send crosses the socket with its options intact", async () => {
  const { bridge, calls } = fakeBridge();
  const path = await serve(bridge);

  const result = await callBridgeControl(path, "send", {
    chat: "iMessage;-;+15551234567",
    text: "hello",
    replyTo: "PARENT-GUID",
    idempotencyKey: "turn-42",
  });

  expect(result).toEqual({ guid: "GUID-1", service: "iMessage" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("send");
  // Threading and the retry key are what a send loses first if the hop is
  // lossy, and losing them is invisible in the resulting message.
  expect(calls[0]!.args[0]).toEqual({
    chat: "iMessage;-;+15551234567",
    text: "hello",
    replyTo: "PARENT-GUID",
    idempotencyKey: "turn-42",
  });
});

test("operations that take positional arguments are unpacked correctly", async () => {
  const { bridge, calls } = fakeBridge();
  const path = await serve(bridge);

  await callBridgeControl(path, "markRead", { chat: "chat9" });
  await callBridgeControl(path, "notifyAnyway", { chat: "chat9", message: "M1" });
  await callBridgeControl(path, "groupAddMembers", { chat: "chat9", members: ["+15550001111"] });

  expect(calls.map((c) => c.method)).toEqual(["markRead", "notifyAnyway", "group.addMembers"]);
  expect(calls[0]!.args).toEqual(["chat9"]);
  expect(calls[1]!.args).toEqual(["chat9", "M1"]);
  expect(calls[2]!.args).toEqual(["chat9", ["+15550001111"]]);
});

test("a void operation resolves rather than hanging", async () => {
  const { bridge } = fakeBridge();
  const path = await serve(bridge);

  await expect(callBridgeControl(path, "typing", { chat: "c", typing: true })).resolves.toBeNull();
});

test("an error from Messages keeps its identity across the socket", async () => {
  const failure = Object.assign(new Error("feature 'edit' is unavailable on this macOS build"), {
    name: "UnsupportedFeatureError",
    code: "unsupported_feature",
  });
  const { bridge } = fakeBridge({
    edit: () => Promise.reject(failure),
  });
  const path = await serve(bridge);

  const error = await callBridgeControl(path, "edit", {
    chat: "c",
    message: "m",
    text: "t",
  }).catch((e: Error) => e);

  // The caller has to be able to tell "this macOS dropped it" from "the bridge
  // is wedged", so the class name and code travel with the message.
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("UnsupportedFeatureError");
  expect((error as { code?: string }).code).toBe("unsupported_feature");
  expect(error.message).toContain("unavailable on this macOS build");
});

test("an unknown operation is refused, not silently dropped", async () => {
  const { bridge } = fakeBridge();
  const path = await serve(bridge);

  await expect(callBridgeControl(path, "definitelyNotAnOp" as never, {} as never)).rejects.toThrow(
    /unknown operation/,
  );
});

test("no daemon listening fails loudly instead of pretending to send", async () => {
  const missing = socketPath();

  const error = await callBridgeControl(missing, "send", {
    chat: "c",
    text: "hi",
  }).catch((e: Error) => e);

  expect(error).toBeInstanceOf(ControlUnreachableError);
  expect(error.message).toContain("cannot reach the daemon");
});

test("a daemon that dies mid-request fails the call", async () => {
  // Never answers, then goes away — the shape of a daemon restarting under a
  // send. Resolving here would report a message sent that no one receives.
  const { bridge } = fakeBridge({
    send: () => new Promise(() => {}),
  });
  const path = socketPath();
  const server = await serveBridgeControl(path, { resolveBridge: () => bridge });

  const pending = callBridgeControl(path, "send", { chat: "c", text: "hi" }, { timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 50));
  await server.close();

  await expect(pending).rejects.toBeInstanceOf(ControlUnreachableError);
});

test("a request that is never answered times out", async () => {
  const { bridge } = fakeBridge({
    send: () => new Promise(() => {}),
  });
  const path = await serve(bridge);

  const error = await callBridgeControl(
    path,
    "send",
    { chat: "c", text: "hi" },
    { timeoutMs: 150 },
  ).catch((e: Error) => e);

  expect(error).toBeInstanceOf(ControlUnreachableError);
  expect(error.message).toContain("within 150ms");
});

test("the socket is owner-only", async () => {
  const { bridge } = fakeBridge();
  const path = await serve(bridge);

  // Anything able to write here can send as the operator.
  expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});

test("a stale socket file left by an unclean exit does not block startup", async () => {
  const { bridge } = fakeBridge();
  const path = socketPath();
  fs.writeFileSync(path, "");

  const server = await serveBridgeControl(path, { resolveBridge: () => bridge });
  cleanups.push(() => server.close());

  await expect(callBridgeControl(path, "status", {})).resolves.toEqual({ ready: true });
});

test("concurrent requests each get their own answer", async () => {
  const { bridge, calls } = fakeBridge();
  const path = await serve(bridge);

  const results = await Promise.all([
    callBridgeControl(path, "send", { chat: "a", text: "1" }),
    callBridgeControl(path, "send", { chat: "b", text: "2" }),
    callBridgeControl(path, "send", { chat: "c", text: "3" }),
  ]);

  expect(results).toHaveLength(3);
  expect(calls).toHaveLength(3);
  expect(calls.map((c) => (c.args[0] as { chat: string }).chat).sort()).toEqual(["a", "b", "c"]);
});
