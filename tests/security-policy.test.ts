/**
 * [security]: the trust decisions, pinned. Defaults fail closed; the live
 * deployment opts back in explicitly. Each test was watched fail against
 * the code before the section existed.
 */

import { describe, expect, test } from "bun:test";
import { directClaudeEnv } from "../src/claude/direct-env.ts";
import { type Config, ConfigSchema } from "../src/config/config.ts";
import { gateInbound } from "../src/gating/allowlist.ts";
import { resolveDmTier } from "../src/guests/access.ts";
import { GuestStore } from "../src/guests/store.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import {
  disallowedBuiltinTools,
  envAllowedWhenSandboxed,
  isOperatorHandle,
  operatorHandles,
  parseSessionTier,
  tierForSessionKey,
} from "../src/security/policy.ts";

function cfg(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
    ...over,
  });
}

function dm(from: string, text = "hi"): InboundMessage {
  return {
    rowid: 1,
    guid: "g",
    chatGuid: `any;-;${from}`,
    chatIdentifier: from,
    fromHandle: from,
    text,
    isGroup: false,
    isFromMe: false,
    date: Date.now(),
    attachments: [],
  } as unknown as InboundMessage;
}

describe("defaults", () => {
  test("a fresh config is sandboxed, contact-tiered, and fails closed on empty allowlists", () => {
    const c = cfg();
    expect(c.security.model_host_access).toBe("sandboxed");
    expect(c.security.contact_tier).toBe("contact");
    expect(c.security.open_dm_allowlist).toBe(false);
    expect(c.security.open_group_allowlist).toBe(false);
    expect(c.dashboard.bind).toBe("127.0.0.1");
  });
});

describe("empty allowlists", () => {
  test("admit nobody unless opened explicitly", () => {
    expect(gateInbound(dm("+15551230001"), cfg()).allow).toBe(false);
    expect(
      gateInbound(dm("+15551230001"), cfg({ security: { open_dm_allowlist: true } })).allow,
    ).toBe(true);
    const group = {
      ...dm("+15551230001", "claude hello"),
      isGroup: true,
      chatGuid: "any;+;chat1",
    } as InboundMessage;
    expect(gateInbound(group, cfg()).allow).toBe(false);
    expect(gateInbound(group, cfg({ security: { open_group_allowlist: true } })).allow).toBe(true);
  });
  test("an explicit allowlist still works as before", () => {
    const c = cfg({ allowlist: { dm: ["+15551230001"], groups: [] } });
    expect(gateInbound(dm("+15551230001"), c).allow).toBe(true);
    expect(gateInbound(dm("+15551230002"), c).allow).toBe(false);
  });
  test("resolveDmTier agrees with the gate", () => {
    const store = new GuestStore(":memory:");
    expect(resolveDmTier("+15551230001", cfg(), store)).toBe("unknown");
    expect(
      resolveDmTier("+15551230001", cfg({ security: { open_dm_allowlist: true } }), store),
    ).toBe("operator");
  });
});

describe("tiers", () => {
  const c = cfg({
    allowlist: { dm: ["+15551230001", "+15551230002"], groups: [] },
    alerts: { operator_handle: "+15551230001" },
  });
  test("the operator handle falls back to alerts.operator_handle and is normalised", () => {
    expect(operatorHandles(c)).toEqual(["+15551230001"]);
    expect(isOperatorHandle(c, "+1 (555) 123-0001")).toBe(true);
    expect(isOperatorHandle(c, "+15551230002")).toBe(false);
    const explicit = cfg({
      security: { operator_handles: ["Owner@Example.com"] },
      alerts: { operator_handle: "+15551230001" },
    });
    expect(operatorHandles(explicit)).toEqual(["owner@example.com"]);
  });
  test("session keys resolve to tiers in one place", () => {
    expect(tierForSessionKey(c, "imessage:dm:+15551230001")).toBe("operator");
    expect(tierForSessionKey(c, "imessage:dm:+15551230002")).toBe("contact");
    expect(tierForSessionKey(c, "sms:dm:+15551230002")).toBe("contact");
    expect(tierForSessionKey(c, "orch:desmond:dm:+15551230001")).toBe("operator");
    expect(tierForSessionKey(c, "imessage:group:any;+;chat1")).toBe("contact");
    expect(tierForSessionKey(c, "mirror:pi-4")).toBe("operator");
    expect(tierForSessionKey(c, "trading:dm:+15551230002")).toBe("operator");
    expect(tierForSessionKey(c, "agent:abc")).toBe("operator");
    expect(tierForSessionKey(c, "imessage:dm:+15551230002", "vouched")).toBe("vouched");
    const permissive = cfg({
      allowlist: { dm: ["+15551230002"], groups: [] },
      security: { contact_tier: "operator" },
    });
    expect(tierForSessionKey(permissive, "imessage:dm:+15551230002")).toBe("operator");
    expect(tierForSessionKey(permissive, "imessage:group:any;+;chat1")).toBe("operator");
  });
  test("an absent tier in a tool process is the contact tier, not the operator", () => {
    expect(parseSessionTier(undefined)).toBe("contact");
    expect(parseSessionTier("garbage")).toBe("contact");
    expect(parseSessionTier("operator")).toBe("operator");
    expect(parseSessionTier("keyed-guest")).toBe("keyed-guest");
  });
});

describe("host access", () => {
  test("sandboxed removes every filesystem and shell built-in, full keeps only Task out", () => {
    expect(disallowedBuiltinTools("full", false)).toBe("Task");
    expect(disallowedBuiltinTools("sandboxed", false)).toBe(
      "Task Bash Read Write Edit NotebookEdit Glob Grep",
    );
    expect(disallowedBuiltinTools("full", true)).toBe(
      "Task Bash Read Write Edit NotebookEdit Glob Grep",
    );
  });
  test("a sandboxed worker inherits an allowlisted environment", () => {
    const saved = { ...process.env };
    process.env.TWILIO_AUTH_TOKEN = "tw-secret";
    process.env.SOME_SHELL_THING = "x";
    process.env.EDMUND_TEST_MARKER = "keep";
    process.env.ANTHROPIC_BASE_URL = "http://stale-proxy";
    try {
      const full = directClaudeEnv({}, "full");
      expect(full.TWILIO_AUTH_TOKEN).toBe("tw-secret");
      expect(full.ANTHROPIC_BASE_URL).toBeUndefined();
      const boxed = directClaudeEnv({ EXTRA: "1" }, "sandboxed");
      expect(boxed.TWILIO_AUTH_TOKEN).toBeUndefined();
      expect(boxed.SOME_SHELL_THING).toBeUndefined();
      expect(boxed.EDMUND_TEST_MARKER).toBe("keep");
      expect(boxed.PATH).toBe(process.env.PATH);
      expect(boxed.HOME).toBe(process.env.HOME);
      expect(boxed.EXTRA).toBe("1");
      expect(envAllowedWhenSandboxed("LC_ALL")).toBe(true);
      expect(envAllowedWhenSandboxed("STRIPE_KEY")).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
