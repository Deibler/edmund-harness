/**
 * Structural tool exclusion for guest sessions (docs/design/guest-access-plan.md):
 * the excluded tools are NOT REGISTERED for guest tiers — the reduction is
 * enforced by assembleCoreTools, not by prompt language. This test builds
 * the real tool lists for an operator session and a keyed-guest session
 * from the same context and asserts the difference is exactly the plan's
 * exclusion surface. (Integration tools and the radaromega/chrome-devtools
 * servers are excluded one layer up — mcp-guest.json + the server's
 * guestTier check — covered by the mcp-config assertions below.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpConfig } from "../src/claude/mcp-config.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { assembleCoreTools } from "../src/mcp/server.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-guest-tools-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(guestTier: ToolContext["guestTier"]): ToolContext {
  const config = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
  });
  config.paths.data_dir = dir;
  // Registration-time-only fake: factories capture these for their handlers,
  // which never run in this test.
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
    guestTier,
  } as unknown as ToolContext;
}

/** Tools the plan excludes from guest sessions — none may register. */
const MUST_BE_ABSENT = [
  "search_history",
  "semantic_search",
  "catch_me_up",
  "read_person_file",
  "write_person_file",
  "remember_about_person",
  "remember_about_self",
  "update_self_memory",
  "memory_search",
  "read_self_memory",
  "request_image_annotation",
  "schedule_reminder",
  "set_trigger",
  "start_mission",
  "spawn_agent",
  "spawn_team",
  "deep_research",
  "handoff_current_work",
  "list_contacts",
  "message_contact",
  "ask_contact",
  "list_skills",
  "read_skill",
  "search_marketplace",
  "install_skill",
  "set_brown_nose",
  "query_ghost",
  "get_portal_link",
  "edit_message",
  "unsend_message",
];

/** The conversational surface guests keep. */
const MUST_BE_PRESENT = [
  "send_message",
  "send_attachment",
  "react",
  "check_incoming",
  "activate_typing",
  "web_search",
  "web_fetch",
  "generate_image",
  "transcribe_audio",
  "analyze_video",
  "check_bg_job",
];

describe("assembleCoreTools", () => {
  test("guest sessions register none of the excluded tools and keep the conversational surface", () => {
    const guestNames = new Set(assembleCoreTools(ctx("keyed-guest")).map((t) => t.name));
    for (const name of MUST_BE_ABSENT) {
      expect(guestNames.has(name)).toBe(false);
    }
    for (const name of MUST_BE_PRESENT) {
      expect(guestNames.has(name)).toBe(true);
    }
  });

  test("vouched sessions get the same reduced loadout as keyed guests", () => {
    const keyed = assembleCoreTools(ctx("keyed-guest")).map((t) => t.name);
    const vouched = assembleCoreTools(ctx("vouched")).map((t) => t.name);
    expect(vouched).toEqual(keyed);
  });

  test("operator sessions still get the full loadout (guest list is a strict subset)", () => {
    const operatorNames = new Set(assembleCoreTools(ctx(null)).map((t) => t.name));
    const guestNames = assembleCoreTools(ctx("keyed-guest")).map((t) => t.name);
    for (const name of guestNames) {
      expect(operatorNames.has(name)).toBe(true);
    }
    for (const name of MUST_BE_ABSENT) {
      expect(operatorNames.has(name)).toBe(true);
    }
  });
});

describe("ensureMcpConfig guest variant", () => {
  test("mcp-guest.json carries ONLY the in-repo server — no radaromega, no chrome-devtools", () => {
    const config = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
      radaromega: { enabled: true, package_path: "./vendor/radaromega-mcp", cdp_port: 9222 },
    });
    config.paths.data_dir = dir;
    const paths = ensureMcpConfig(config);
    const guest = JSON.parse(readFileSync(paths.guest, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(guest.mcpServers)).toEqual(["edmund-harness"]);
  });
});
