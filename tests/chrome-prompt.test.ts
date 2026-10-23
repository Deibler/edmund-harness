/**
 * The system prompt describes the browser truthfully for the whole
 * conversation. It promised chrome-devtools on every worker, but the tools
 * load only on a turn that carries a link or asks to browse: 43 of 101 chrome
 * lookups failed (2026-10-23). And the text cannot follow each worker's
 * loadout: a conversation moves between workers with and without the
 * browser, and a prompt that changed with them would rewrite the cached
 * prefix at every switch.
 */
import { describe, expect, test } from "bun:test";
import { envelopeNeedsBrowser } from "../src/claude/mcp-config.ts";
import { buildSystemPrompt } from "../src/claude/system-prompt.ts";

const prompt = (over: Record<string, unknown> = {}) =>
  buildSystemPrompt({
    senderLabel: "Riley",
    senderHandle: null,
    isGroup: false,
    sandboxPath: "/tmp/edmund-chrome-test",
    radarOmegaEnabled: true,
    ...over,
  });

describe("the Chrome section", () => {
  test("a session that can get Chrome is told how it arrives", () => {
    const p = prompt();
    expect(p).toContain("**Loaded on demand.**");
    expect(p).toContain("If they are not in your tool list this turn, don't search for them");
    expect(p).not.toContain("%%CHROME%%");
    // The documented way in really loads the browser on the next turn.
    expect(envelopeNeedsBrowser("Continue in Chrome: check the order status")).toBe(true);
  });

  test("a guest or trading session is told there is no browser", () => {
    for (const p of [prompt({ guestTier: "vouched" }), prompt({ isTrading: true })]) {
      expect(p).toContain("No browser in this session");
      expect(p).not.toContain("Loaded on demand");
      expect(p).not.toContain('schedule_reminder(when: "in 10 seconds"');
    }
  });

  test("the RadarOmega switch still works alongside it", () => {
    expect(prompt({ radarOmegaEnabled: false })).not.toContain("RadarOmega — THE weather source");
    expect(prompt({ radarOmegaEnabled: false })).not.toContain("%%RADAROMEGA%%");
    expect(prompt()).toContain("RadarOmega — THE weather source");
  });
});
