/**
 * The contact tier is a structural reduction, like the guest tier: the
 * excluded tools are not registered. Built from the same context as an
 * operator session so the difference is exactly the policy set.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { CONTACT_TIER_EXCLUDED, assembleCoreTools } from "../src/mcp/server.ts";
import type { SessionTier } from "../src/security/policy.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-tier-tools-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(sessionTier: SessionTier): ToolContext {
  const config = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
  });
  config.paths.data_dir = dir;
  return {
    config,
    cron: null,
    chatDb: null,
    contacts: null,
    sessionKey: "imessage:dm:+15559990000",
    chatGuids: [],
    sandboxPath: dir,
    dataDir: dir,
    bgJobs: null,
    guestTier: sessionTier === "keyed-guest" || sessionTier === "vouched" ? sessionTier : null,
    sessionTier,
  } as unknown as ToolContext;
}

const names = (tier: SessionTier) => new Set(assembleCoreTools(ctx(tier)).map((t) => t.name));

describe("contact tier", () => {
  test("loses exactly the policy set and nothing else", () => {
    const operator = names("operator");
    const contact = names("contact");
    for (const n of CONTACT_TIER_EXCLUDED) {
      expect(operator.has(n)).toBe(true);
      expect(contact.has(n)).toBe(false);
    }
    const lost = [...operator].filter((n) => !contact.has(n)).sort();
    expect(lost).toEqual([...CONTACT_TIER_EXCLUDED].sort());
  });
  test("keeps this-conversation tools", () => {
    const contact = names("contact");
    for (const n of [
      "send_message",
      "react",
      "search_history",
      "semantic_search",
      "remember_about_person",
      "read_person_file",
      "schedule_reminder",
      "generate_image",
      "list_skills",
      "read_skill",
      "create_skill",
      "spawn_agent",
    ]) {
      expect(contact.has(n)).toBe(true);
    }
  });
  test("guest tiers are unchanged by the contact policy", () => {
    const guest = names("keyed-guest");
    expect(guest.has("send_message")).toBe(true);
    expect(guest.has("search_history")).toBe(false);
    expect(guest.has("list_contacts")).toBe(false);
  });
});
