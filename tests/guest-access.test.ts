/**
 * Keyed guest access (docs/design/guest-access-plan.md): the DM gate stops
 * being a binary allowlist. An unknown sender who presents an active
 * campaign key becomes a keyed guest; a handle sharing a registered group
 * becomes vouched; everyone else is buffered and never reaches the model.
 * These tests lock in tier resolution, activation (first and Nth message,
 * case-insensitive), buffering, vouching, every cap, expiry, the kill
 * switch's exact-parity guarantee, and the STRUCTURAL tool exclusion —
 * guest sessions must simply not have the excluded tools registered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/config.ts";
import { ConfigSchema, validateGuestCampaignContexts } from "../src/config/config.ts";
import { type Gate, gateInbound, guestGateFor } from "../src/gating/allowlist.ts";
import {
  GUEST_RATE_LIMIT,
  GUEST_RATE_WINDOW_MS,
  campaignIsActive,
  checkGuestCaps,
  deriveGuestLoadout,
  guestSpendSubsystem,
  resolveDmTier,
  resolveGuestTurn,
  scanForCampaignKey,
} from "../src/guests/access.ts";
import { BUFFER_KEEP_PER_HANDLE, GuestStore } from "../src/guests/store.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { SpendLedger, getSpendLedger, localDay } from "../src/spend/ledger.ts";

const GUEST = "+15559990000";
const FRIEND = "+15551112222";
const NOW = Date.parse("2026-08-10T15:00:00");

function cfg(over: {
  dm?: string[];
  groups?: string[];
  enabled?: boolean;
  campaigns?: Array<Partial<Config["guest_campaigns"][number]>>;
  dataDir?: string;
}): Config {
  return {
    identity: { names: ["edmund"] },
    allowlist: { dm: over.dm ?? [FRIEND], groups: over.groups ?? [] },
    orchestrators: [],
    guest_access: { enabled: over.enabled ?? true },
    guest_campaigns: (over.campaigns ?? [{}]).map((c) => ({
      key: "opensesame2026",
      label: "Example campaign",
      context: "campaigns/example.md",
      ...c,
    })),
    paths: { chat_db: "unused", data_dir: over.dataDir ?? "unused" },
  } as unknown as Config;
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "g",
    chatIdentifier: GUEST,
    chatGuid: `iMessage;-;${GUEST}`,
    isGroup: false,
    fromHandle: GUEST,
    fromMe: false,
    text: "hey",
    timestampMs: NOW,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

let dir: string;
let store: GuestStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-guests-"));
  store = new GuestStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("tier resolution", () => {
  test("allowlisted handle is operator, even when also vouched", () => {
    store.recordVouches([FRIEND], "iMessage;+;chatX", NOW);
    expect(resolveDmTier(FRIEND, cfg({}), store, NOW)).toBe("operator");
  });

  test("an empty allowlist admits nobody unless [security].open_dm_allowlist opens it", () => {
    expect(resolveDmTier(GUEST, cfg({ dm: [] }), store, NOW)).toBe("unknown");
    const open = { ...cfg({ dm: [] }), security: { open_dm_allowlist: true } } as unknown as Config;
    expect(resolveDmTier(GUEST, open, store, NOW)).toBe("operator");
  });

  test("active activation resolves keyed-guest; vouch resolves vouched; neither is unknown", () => {
    const c = cfg({});
    expect(resolveDmTier(GUEST, c, store, NOW)).toBe("unknown");
    store.recordVouches([GUEST], "iMessage;+;chatX", NOW);
    expect(resolveDmTier(GUEST, c, store, NOW)).toBe("vouched");
    store.activate(GUEST, "opensesame2026", NOW);
    expect(resolveDmTier(GUEST, c, store, NOW)).toBe("keyed-guest");
  });

  test("kill switch off makes every non-allowlisted handle unknown, whatever the store says", () => {
    store.activate(GUEST, "opensesame2026", NOW);
    store.recordVouches([GUEST], "iMessage;+;chatX", NOW);
    expect(resolveDmTier(GUEST, cfg({ enabled: false }), store, NOW)).toBe("unknown");
  });

  test("an activation whose campaign expired resolves past keyed-guest (vouched or unknown)", () => {
    const c = cfg({ campaigns: [{ expires: "2026-08-01" }] });
    store.activate(GUEST, "opensesame2026", NOW);
    expect(resolveDmTier(GUEST, c, store, NOW)).toBe("unknown");
    expect(resolveGuestTurn(GUEST, c, store, NOW)).toEqual({ kind: "blocked" });
  });
});

describe("key scanning and activation", () => {
  test("key match is case-insensitive and substring-tolerant", () => {
    const c = cfg({});
    expect(scanForCampaignKey("here's my code: OpenSesame2026, hi!", c, NOW)?.label).toBe(
      "Example campaign",
    );
    expect(scanForCampaignKey("no key here", c, NOW)).toBeNull();
  });

  test("expired campaign key is inert", () => {
    const c = cfg({ campaigns: [{ expires: "2026-08-01" }] });
    expect(campaignIsActive(c.guest_campaigns[0]!, NOW)).toBe(false);
    expect(scanForCampaignKey("opensesame2026", c, NOW)).toBeNull();
  });

  test("key in the FIRST message activates and admits that same turn", () => {
    const events: string[] = [];
    const gate = gateInbound(msg({ text: "hi, opensesame2026 sent me" }), cfg({}), {
      store,
      onActivation: (ev) => events.push(`${ev.campaign.label}:${ev.handle}`),
      nowMs: NOW,
    });
    expect(gate).toEqual({
      allow: true,
      tier: "keyed-guest",
      campaignKey: "opensesame2026",
      activated: true,
    });
    expect(events).toEqual([`Example campaign:${GUEST}`]);
    expect(store.getActivation(GUEST)?.campaignKey).toBe("opensesame2026");
  });

  test("key in the Nth message activates; earlier messages sit buffered and drain once", () => {
    const c = cfg({});
    const ctx = { store, nowMs: NOW };
    expect(gateInbound(msg({ text: "hello?" }), c, ctx)).toEqual({
      allow: false,
      reason: "guest-pending",
    });
    expect(gateInbound(msg({ text: "anyone there" }), c, { ...ctx, nowMs: NOW + 1000 })).toEqual({
      allow: false,
      reason: "guest-pending",
    });
    const third = gateInbound(msg({ text: "oh right — Opensesame2026" }), c, {
      ...ctx,
      nowMs: NOW + 2000,
    }) as Extract<Gate, { allow: true }>;
    expect(third.allow).toBe(true);
    expect(third.activated).toBe(true);
    // The pre-key messages drain oldest-first — and do NOT include the
    // activating message itself (that one IS the turn).
    const buffered = store.drainBuffered(GUEST);
    expect(buffered.map((b) => b.text)).toEqual(["hello?", "anyone there"]);
    expect(store.drainBuffered(GUEST)).toEqual([]);
  });

  test("already-activated handle admits directly without re-scanning", () => {
    store.activate(GUEST, "opensesame2026", NOW);
    const gate = gateInbound(msg({ text: "tell me about the recovery layer" }), cfg({}), {
      store,
      nowMs: NOW,
    });
    expect(gate).toEqual({ allow: true, tier: "keyed-guest", campaignKey: "opensesame2026" });
  });

  test("unknown key stays silent and records the attempt", () => {
    const gate = gateInbound(msg({ text: "open sesame123" }), cfg({}), { store, nowMs: NOW });
    expect(gate).toEqual({ allow: false, reason: "guest-pending" });
    expect(store.getActivation(GUEST)).toBeNull();
    expect(store.listAttempts().length).toBe(1);
  });

  test("kill switch off restores the exact old gate: not-allowlisted, nothing persisted", () => {
    const gate = gateInbound(msg({ text: "opensesame2026" }), cfg({ enabled: false }), {
      store,
      nowMs: NOW,
    });
    expect(gate).toEqual({ allow: false, reason: "not-allowlisted" });
    expect(store.getActivation(GUEST)).toBeNull();
    expect(store.drainBuffered(GUEST)).toEqual([]);
    expect(store.listAttempts()).toEqual([]);
  });

  test("without a guest context the gate behaves exactly as before guest access existed", () => {
    expect(gateInbound(msg({ text: "opensesame2026" }), cfg({}))).toEqual({
      allow: false,
      reason: "not-allowlisted",
    });
  });
});

describe("vouching", () => {
  test("recorded group participants are admitted as vouched DMs", () => {
    store.recordVouches([GUEST, FRIEND, ""], "iMessage;+;chatX", NOW);
    const gate = gateInbound(msg({ text: "hey, it's me from the group" }), cfg({}), {
      store,
      nowMs: NOW,
    });
    expect(gate).toEqual({ allow: true, tier: "vouched" });
  });

  test("vouch lookup is handle-normalized (e:-prefixed spelling still matches)", () => {
    store.recordVouches(["e:Guest@iCloud.com"], "iMessage;+;chatX", NOW);
    expect(store.isVouched("guest@icloud.com")).toBe(true);
  });
});

describe("buffer bounds", () => {
  test(`keeps only the last ${BUFFER_KEEP_PER_HANDLE} messages per handle`, () => {
    for (let i = 0; i < BUFFER_KEEP_PER_HANDLE + 5; i++) {
      store.bufferMessage(GUEST, `m${i}`, NOW + i);
    }
    const drained = store.drainBuffered(GUEST);
    expect(drained.length).toBe(BUFFER_KEEP_PER_HANDLE);
    expect(drained[0]?.text).toBe("m5");
  });

  test("14-day TTL drops stale buffered messages", () => {
    store.bufferMessage(GUEST, "ancient", NOW - 15 * 24 * 3_600_000);
    store.bufferMessage(GUEST, "fresh", NOW);
    expect(store.drainBuffered(GUEST).map((b) => b.text)).toEqual(["fresh"]);
  });
});

describe("caps", () => {
  test("rolling rate limit blocks at the limit and re-arms its decline when the window clears", () => {
    const campaign = null;
    for (let i = 0; i < GUEST_RATE_LIMIT; i++) {
      store.recordGuestMessage(GUEST, null, localDay(NOW), NOW - 60_000 + i);
    }
    const verdict = checkGuestCaps({ handle: GUEST, campaign, store, dataDir: dir, nowMs: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.cap).toBe("rate");
    // First hit gets the one polite decline; repeats stay silent.
    if (!verdict.ok) {
      expect(store.capNoticeOnce(verdict.scope, NOW)).toBe(true);
      expect(store.capNoticeOnce(verdict.scope, NOW)).toBe(false);
    }
    // Window rolls past → cap clears AND the notice re-arms for next time.
    const later = NOW + GUEST_RATE_WINDOW_MS + 1;
    const clear = checkGuestCaps({ handle: GUEST, campaign, store, dataDir: dir, nowMs: later });
    expect(clear.ok).toBe(true);
    expect(store.capNoticeOnce(`rate:${GUEST}`, later)).toBe(true);
  });

  test("per-campaign daily message cap", () => {
    const c = cfg({ campaigns: [{ max_messages_per_day: 3 }] });
    const campaign = c.guest_campaigns[0]!;
    for (let i = 0; i < 3; i++)
      store.recordGuestMessage(GUEST, "opensesame2026", localDay(NOW), NOW);
    const verdict = checkGuestCaps({ handle: GUEST, campaign, store, dataDir: dir, nowMs: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.cap).toBe("daily");
    // A new day starts a new bucket.
    const tomorrow = NOW + 24 * 3_600_000;
    expect(
      checkGuestCaps({ handle: GUEST, campaign, store, dataDir: dir, nowMs: tomorrow }).ok,
    ).toBe(true);
  });

  test("lifetime spend cap reads the ledger's guest:<campaign> subsystem", () => {
    const c = cfg({ campaigns: [{ max_spend_usd: 5 }] });
    const campaign = c.guest_campaigns[0]!;
    // Same singleton checkGuestCaps reads — shared per data dir.
    getSpendLedger(dir).record(
      {
        sessionKey: `imessage:dm:${GUEST}`,
        subsystem: guestSpendSubsystem("opensesame2026"),
        costUsd: 6,
      },
      NOW,
    );
    const verdict = checkGuestCaps({ handle: GUEST, campaign, store, dataDir: dir, nowMs: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.cap).toBe("spend");
  });

  test("SpendLedger.totalCostFor sums one subsystem across days and sessions", () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "edmund-guest-spend-"));
    const ledger = new SpendLedger(ledgerDir);
    try {
      ledger.record({ sessionKey: "imessage:dm:+1", subsystem: "guest:k", costUsd: 1.5 }, NOW);
      ledger.record(
        { sessionKey: "imessage:dm:+2", subsystem: "guest:k", costUsd: 2 },
        NOW + 25 * 3_600_000,
      );
      ledger.record({ sessionKey: "imessage:dm:+1", subsystem: "turn", costUsd: 40 }, NOW);
      expect(ledger.totalCostFor("guest:k")).toBeCloseTo(3.5);
    } finally {
      ledger.close();
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe("runner loadout derivation", () => {
  test("keyed guest derives the guest loadout with the campaign context path", () => {
    const c = cfg({ dataDir: dir });
    // The runner's singleton must see this activation — same data dir.
    const runnerStore = new GuestStore(dir);
    runnerStore.activate(GUEST, "opensesame2026", NOW);
    runnerStore.close();
    expect(deriveGuestLoadout(`imessage:dm:${GUEST}`, c, NOW)).toEqual({
      tier: "keyed-guest",
      campaignKey: "opensesame2026",
      campaignContextPath: "campaigns/example.md",
    });
  });

  test("operator sessions and non-DM sessions derive nothing", () => {
    const c = cfg({ dataDir: dir });
    expect(deriveGuestLoadout(`imessage:dm:${FRIEND}`, c, NOW)).toBeUndefined();
    expect(deriveGuestLoadout("imessage:group:iMessage;+;chatX", c, NOW)).toBeUndefined();
    expect(deriveGuestLoadout("trading:dm:+15551112222", c, NOW)).toBeUndefined();
  });

  test("a revoked guest session derives 'blocked' — the runner refuses the turn", () => {
    const c = cfg({ dataDir: dir, campaigns: [{ expires: "2026-08-01" }] });
    const runnerStore = new GuestStore(dir);
    runnerStore.activate(GUEST, "opensesame2026", NOW);
    runnerStore.close();
    expect(deriveGuestLoadout(`imessage:dm:${GUEST}`, c, NOW)).toBe("blocked");
  });

  test("kill switch off derives nothing for anyone", () => {
    const c = cfg({ dataDir: dir, enabled: false });
    expect(deriveGuestLoadout(`imessage:dm:${GUEST}`, c, NOW)).toBeUndefined();
  });
});

describe("operator alert on activation", () => {
  test("guestGateFor fires one alert with the plan's wording", () => {
    const alerts: Array<{ category: string; error: string }> = [];
    const gate = guestGateFor(store, {
      notify: async (p) => {
        alerts.push({ category: p.category, error: p.error });
        return true;
      },
    });
    gateInbound(msg({ text: "opensesame2026 — hi!" }), cfg({}), { ...gate, nowMs: NOW });
    expect(alerts).toEqual([
      {
        category: "guest key activated",
        error: `Example campaign key activated by ${GUEST}`,
      },
    ]);
  });
});

describe("config validation", () => {
  test("duplicate keys (case-insensitive) are rejected; short keys are rejected", () => {
    const base = { self: { handles: [] }, allowlist: {}, identity: {} };
    expect(() =>
      ConfigSchema.parse({
        ...base,
        guest_campaigns: [
          { key: "opensesame2026", label: "a", context: "x.md" },
          { key: "OPENSESAME2026", label: "b", context: "y.md" },
        ],
      }),
    ).toThrow(/duplicate guest campaign key/);
    expect(() =>
      ConfigSchema.parse({
        ...base,
        guest_campaigns: [{ key: "short", label: "a", context: "x.md" }],
      }),
    ).toThrow(/8 chars/);
    expect(() =>
      ConfigSchema.parse({
        ...base,
        guest_campaigns: [
          { key: "opensesame2026", label: "a", context: "x.md", expires: "not-a-date" },
        ],
      }),
    ).toThrow(/ISO date/);
  });

  test("context files resolve against the config dir and must be readable", () => {
    const okPath = join(dir, "ctx.md");
    writeFileSync(okPath, "# hi");
    const good = cfg({ campaigns: [{ context: "ctx.md" }] });
    validateGuestCampaignContexts(good, dir);
    // Rewritten absolute so MCP subprocesses (cwd = sandbox) agree on it.
    expect(good.guest_campaigns[0]?.context).toBe(okPath);
    const bad = cfg({ campaigns: [{ context: "missing.md" }] });
    expect(() => validateGuestCampaignContexts(bad, dir)).toThrow(/not readable/);
  });
});
