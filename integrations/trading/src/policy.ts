import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Policy, PolicyLimits } from "./types.ts";

/**
 * File-backed trading policy. Two artifacts kept in lockstep:
 *   - policy.json — the machine-readable hard limits the risk engine enforces.
 *   - policy.md   — a human-readable mirror Jordan (and the dashboard) can read.
 *
 * Account-global (one Robinhood account), so it lives in a single shared
 * trading dir, not per-session. Writes are atomic (temp + rename) and bump a
 * monotonic version; history is recorded in trading.db by the caller.
 */

const LimitsSchema = z.object({
  maxPctPerName: z.number().min(0).max(1).default(0.3),
  maxPositionUSD: z.number().nonnegative().default(10_000),
  dailyLossLimitUSD: z.number().nonnegative().default(50),
  maxTradesPerDay: z.number().int().nonnegative().default(10),
  cashFloorUSD: z.number().nonnegative().default(0),
  allowShort: z.boolean().default(false),
  allowFractional: z.boolean().default(true),
  allowedSymbols: z.array(z.string()).default([]),
  forbiddenSymbols: z.array(z.string()).default([]),
});

const PolicySchema = z.object({
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.number().default(0),
  vision: z.string().default(""),
  limits: LimitsSchema.default({}),
  killSwitch: z.boolean().default(false),
});

function defaultPolicy(): Policy {
  return PolicySchema.parse({
    version: 1,
    updatedAt: 0,
    vision:
      "No vision set yet. Small account — protect capital, diversify, never over-size one name.",
    limits: {
      // Primary limit: at most 30% of equity in any single position.
      maxPctPerName: 0.3,
      maxPositionUSD: 10_000,
      dailyLossLimitUSD: 50,
      maxTradesPerDay: 10,
      cashFloorUSD: 0,
      allowShort: false,
      allowFractional: true,
      allowedSymbols: [],
      forbiddenSymbols: [],
    },
    killSwitch: false,
  });
}

export class PolicyStore {
  private dir: string;
  private jsonPath: string;
  private mdPath: string;

  constructor(baseDir: string) {
    this.dir = baseDir;
    this.jsonPath = join(baseDir, "policy.json");
    this.mdPath = join(baseDir, "policy.md");
  }

  read(): Policy {
    if (!existsSync(this.jsonPath)) {
      const p = defaultPolicy();
      this.writeRaw(p);
      return p;
    }
    try {
      const raw = JSON.parse(readFileSync(this.jsonPath, "utf8")) as unknown;
      return PolicySchema.parse(raw);
    } catch {
      // Corrupt file — fall back to default rather than crash a trading turn.
      return defaultPolicy();
    }
  }

  /**
   * Apply a partial patch (vision and/or individual limits + killSwitch),
   * bump the version, persist atomically, and return the new policy. The
   * caller records history in trading.db.
   */
  write(
    patch: {
      vision?: string;
      limits?: Partial<PolicyLimits>;
      killSwitch?: boolean;
    },
    nowMs: number,
  ): Policy {
    const cur = this.read();
    const next: Policy = PolicySchema.parse({
      version: cur.version + 1,
      updatedAt: nowMs,
      vision: patch.vision ?? cur.vision,
      limits: { ...cur.limits, ...(patch.limits ?? {}) },
      killSwitch: patch.killSwitch ?? cur.killSwitch,
    });
    this.writeRaw(next);
    return next;
  }

  private writeRaw(p: Policy): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.jsonPath, JSON.stringify(p, null, 2));
    atomicWrite(this.mdPath, renderMarkdown(p));
  }

  get markdownPath(): string {
    return this.mdPath;
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function renderMarkdown(p: Policy): string {
  const l = p.limits;
  return [
    `# Trading policy (v${p.version})`,
    "",
    `_Last updated: ${p.updatedAt ? new Date(p.updatedAt).toISOString() : "never"}_`,
    "",
    "## Vision",
    "",
    p.vision || "_(none)_",
    "",
    "## Hard limits (enforced in code)",
    "",
    `- **Max % of equity per position:** ${(l.maxPctPerName * 100).toFixed(1)}%`,
    `- Max position (absolute): $${l.maxPositionUSD}`,
    `- Daily loss limit: $${l.dailyLossLimitUSD}`,
    `- Max trades/day: ${l.maxTradesPerDay}`,
    `- Cash floor: $${l.cashFloorUSD}`,
    `- Shorting: ${l.allowShort ? "allowed" : "disabled"}`,
    `- Fractional shares: ${l.allowFractional ? "allowed" : "disabled"}`,
    `- Allowed symbols: ${l.allowedSymbols.length ? l.allowedSymbols.join(", ") : "(any)"}`,
    `- Forbidden symbols: ${l.forbiddenSymbols.length ? l.forbiddenSymbols.join(", ") : "(none)"}`,
    `- Kill switch: ${p.killSwitch ? "ON (halted)" : "off"}`,
    "",
  ].join("\n");
}
