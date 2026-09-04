import { afterEach, expect, mock, test } from "bun:test";

import { isPermanentSendError, isTransient } from "../src/imessage/actions/classify.ts";
import { chatTarget } from "../src/imessage/actions/target.ts";

// `sendMessage` reaches Messages through `invoke`, so the bridge module is
// mocked and these assert the behaviour that used to need chat.db heuristics:
// one idempotency key across retries, retry only what can clear, and no second
// delivery path underneath.

const invoke = mock(() => Promise.resolve({ guid: "G1" }));
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

const { sendMessage } = await import("../src/imessage/actions/send.ts");

const succeed = () => Promise.resolve({ guid: "G1" });

afterEach(() => {
  // Clearing calls alone would leave a previous test's rejection in place, so
  // the default behaviour is restored too.
  invoke.mockClear();
  invoke.mockImplementation(succeed);
});

function transient(name = "RpcTimeoutError", code = "timeout"): Error {
  return Object.assign(new Error("'send' did not respond within 20000ms"), { name, code });
}

function permanent(): Error {
  return Object.assign(new Error("no chat matching 'nobody'"), {
    name: "ChatNotFoundError",
    code: "chat_not_found",
  });
}

test("text and attachments travel as one message", async () => {
  await sendMessage({
    to: "+15551234567",
    isGroup: false,
    text: "look at this",
    attachments: ["/tmp/photo.jpg"],
  });

  const [, options] = invoke.mock.calls[0] as [string, Record<string, unknown>];
  expect(options.text).toBe("look at this");
  expect(options.files).toEqual(["/tmp/photo.jpg"]);
});

test("every retry of a message carries the same idempotency key", async () => {
  invoke
    .mockImplementationOnce(() => Promise.reject(transient()))
    .mockImplementationOnce(() => Promise.reject(transient()))
    .mockImplementationOnce(() => Promise.resolve({ guid: "G1", duplicate: true }));

  const result = await sendMessage({ to: "+1555", isGroup: false, text: "hi" });

  expect(result).toEqual({ ok: true });
  expect(invoke).toHaveBeenCalledTimes(3);
  // The whole point: a send that landed and lost its reply comes back as a
  // duplicate instead of arriving twice.
  const keys = (invoke.mock.calls as [string, { idempotencyKey?: string }][]).map(
    ([, options]) => options.idempotencyKey,
  );
  expect(keys[0]).toBeTruthy();
  expect(new Set(keys).size).toBe(1);
});

test("two separate messages do not share a key", async () => {
  await sendMessage({ to: "+1555", isGroup: false, text: "one" });
  await sendMessage({ to: "+1555", isGroup: false, text: "two" });

  const keys = (invoke.mock.calls as [string, { idempotencyKey?: string }][]).map(
    ([, options]) => options.idempotencyKey,
  );
  expect(new Set(keys).size).toBe(2);
});

test("a permanent failure is not retried", async () => {
  invoke.mockImplementation(() => Promise.reject(permanent()));

  const result = await sendMessage({ to: "+1555", isGroup: false, text: "hi" });

  expect(result.ok).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ error: expect.stringContaining("chat_not_found") });
});

test("a send that never succeeds fails loudly rather than falling back", async () => {
  invoke.mockImplementation(() => Promise.reject(transient()));

  const result = await sendMessage({ to: "+1555", isGroup: false, text: "hi" });

  expect(result.ok).toBe(false);
  expect(result).toMatchObject({ error: expect.stringContaining("attempts") });
  // Bounded: no unbounded ladder, and every call was the one send operation.
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(new Set((invoke.mock.calls as [string, unknown][]).map(([op]) => op))).toEqual(
    new Set(["send"]),
  );
});

test("an empty message is refused before it reaches Messages", async () => {
  expect(await sendMessage({ to: "+1555", isGroup: false, text: "   " })).toEqual({
    ok: false,
    error: "empty message",
  });
  expect(invoke).not.toHaveBeenCalled();
});

test("no service is EVER named — the conversation keeps its own routing", async () => {
  // Naming a service invoked sendMessage:onAccount: whenever the chat's
  // binding disagreed — the call that re-registers the chat against our own
  // account inside imagent (the note-to-self poisoning). SendArgs has no
  // service field any more; even a stale caller smuggling one past the types
  // must not see it forwarded to the bridge.
  await sendMessage({ to: "+1555", isGroup: false, text: "hi" });
  const [, options] = invoke.mock.calls[0] as [string, Record<string, unknown>];
  expect(options).not.toHaveProperty("service");

  invoke.mockClear();
  await sendMessage({
    to: "+1555",
    isGroup: false,
    text: "hi",
    service: "SMS",
  } as Parameters<typeof sendMessage>[0]);
  const [, sms] = invoke.mock.calls[0] as [string, Record<string, unknown>];
  expect(sms).not.toHaveProperty("service");
});

test("threading and effects are passed through", async () => {
  await sendMessage({
    to: "chat123",
    isGroup: true,
    chatGuid: "iMessage;+;chat123",
    text: "threaded",
    replyTo: "PARENT",
    // The model writes the short name, which is what the tool advertises.
    effect: "impact",
    subject: "Heads up",
  });

  const [, options] = invoke.mock.calls[0] as [string, Record<string, unknown>];
  expect(options.chat).toBe("iMessage;+;chat123");
  expect(options.replyTo).toBe("PARENT");
  // IMCore takes the full identifier; passing the short name through unmapped
  // would be accepted here and then ignored on the wire.
  expect(options.effect).toBe("com.apple.MobileSMS.expressivesend.impact");
  expect(options.subject).toBe("Heads up");
});

test("a screen effect maps to its IMCore identifier", async () => {
  await sendMessage({ to: "+1555", isGroup: false, text: "congrats", effect: "confetti" });
  const [, options] = invoke.mock.calls[0] as [string, Record<string, unknown>];
  expect(options.effect).toBe("com.apple.messages.effect.CKConfettiEffect");
});

test("an unrecognised effect drops off and the text still sends", async () => {
  const result = await sendMessage({
    to: "+1555",
    isGroup: false,
    text: "hi",
    effect: "not-a-real-effect",
  });

  expect(result).toEqual({ ok: true });
  const [, options] = invoke.mock.calls[0] as [string, Record<string, unknown>];
  expect(options).not.toHaveProperty("effect");
  expect(options.text).toBe("hi");
});

test("a chat GUID from chat.db is preferred over the handle", () => {
  expect(chatTarget({ to: "+1555", isGroup: false, chatGuid: "iMessage;-;+1555" })).toBe(
    "iMessage;-;+1555",
  );
  expect(chatTarget({ to: "+1555", isGroup: false })).toBe("+1555");
  expect(chatTarget({ to: "chat9", isGroup: true })).toBe("chat9");
});

test("transience is decided by type, not by the wording of a message", () => {
  expect(isTransient(transient())).toBe(true);
  expect(isTransient(transient("BridgeUnavailableError", "bridge_unavailable"))).toBe(true);
  expect(isTransient(permanent())).toBe(false);
  // A permanent error whose prose happens to mention a timeout stays permanent.
  expect(isTransient(Object.assign(new Error("timed out"), { name: "ChatNotFoundError" }))).toBe(
    false,
  );
});

test("permanence survives being rendered to a string", () => {
  expect(isPermanentSendError("RpcTimeoutError[timeout]: no answer")).toBe(false);
  expect(
    isPermanentSendError("after 4 attempts: BridgeUnavailableError: no bridge connected"),
  ).toBe(false);
  expect(isPermanentSendError("ControlUnreachableError[control_unreachable]: down")).toBe(false);
  expect(
    isPermanentSendError("SelfRouteRecoveryError[self_route_unrecovered]: registry still poisoned"),
  ).toBe(false);
  expect(isPermanentSendError("UnsupportedFeatureError[unsupported_feature]: gone")).toBe(true);
  expect(isPermanentSendError("ChatNotFoundError[chat_not_found]: nobody")).toBe(true);
});
