/**
 * The system prompt describes the browser the worker actually has. It
 * promised chrome-devtools on every worker, but the tools load only when a
 * message carries a link or asks to browse: 43 of 101 chrome lookups failed
 * on workers spawned without them (2026-10-23).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envelopeNeedsBrowser, hasBrowser } from "../src/claude/mcp-config.ts";
import { buildSystemPrompt } from "../src/claude/system-prompt.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { buildRunSystemPrompt } from "../src/model/context.ts";

const prompt = (browserLoaded: boolean | undefined, radarOmegaEnabled = true) =>
  buildSystemPrompt({
    senderLabel: "Riley",
    senderHandle: null,
    isGroup: false,
    sandboxPath: "/tmp/edmund-chrome-test",
    radarOmegaEnabled,
    browserLoaded,
  });

describe("the Chrome section", () => {
  test("a worker with chrome-devtools is told it has them", () => {
    for (const p of [prompt(true), prompt(undefined)]) {
      expect(p).toContain("You have `chrome-devtools` tools for the live web");
      expect(p).not.toContain("Chrome is not loaded");
    }
  });

  test("a worker without them is told so, and how to get them", () => {
    const p = prompt(false);
    expect(p).toContain("Chrome is not loaded in this session");
    expect(p).not.toContain("You have `chrome-devtools` tools for the live web");
    expect(p).not.toContain("%%CHROME%%");
    // The documented way in really loads the browser on the next turn.
    expect(envelopeNeedsBrowser("Continue in Chrome: check the order status")).toBe(true);
  });

  test("the run prompt passes the loadout through", () => {
    const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
    const input = {
      sessionKey: "imessage:dm:+15550100041" as const,
      senderLabel: "Riley",
      senderHandle: "+15550100041",
      sandboxPath: "/tmp/edmund-chrome-test",
    };
    expect(buildRunSystemPrompt(input, config, null, { browser: false })).toContain(
      "Chrome is not loaded in this session",
    );
    expect(buildRunSystemPrompt(input, config, null, { browser: true })).not.toContain(
      "Chrome is not loaded in this session",
    );
  });

  test("the RadarOmega switch still works alongside it", () => {
    expect(prompt(false, false)).not.toContain("RadarOmega — THE weather source");
    expect(prompt(false, true)).toContain("RadarOmega — THE weather source");
    expect(prompt(true, false)).not.toContain("%%RADAROMEGA%%");
  });
});

describe("which loadout has a browser", () => {
  const paths = {
    default: "/d/mcp.json",
    withBrowser: "/d/mcp-browser.json",
    contact: "/d/mcp-contact.json",
    contactWithBrowser: "/d/mcp-contact-browser.json",
    trading: "/d/mcp-trading.json",
    guest: "/d/mcp-guest.json",
  } as never;

  test("only the two browser configs", () => {
    expect(hasBrowser(paths, "/d/mcp-browser.json")).toBe(true);
    expect(hasBrowser(paths, "/d/mcp-contact-browser.json")).toBe(true);
    expect(hasBrowser(paths, "/d/mcp.json")).toBe(false);
    expect(hasBrowser(paths, "/d/mcp-trading.json")).toBe(false);
  });

  test("both runners describe the config they chose", () => {
    const claude = readFileSync(join(import.meta.dir, "../src/claude/runner.ts"), "utf8");
    expect(claude).toContain("{ browser: hasBrowser(mcpConfigs, mcpConfigPath) }");
    const codex = readFileSync(join(import.meta.dir, "../src/codex/runner.ts"), "utf8");
    expect(codex).toContain("browser: !isGuest && hasBrowser(configs, mcpConfig),");
  });
});
