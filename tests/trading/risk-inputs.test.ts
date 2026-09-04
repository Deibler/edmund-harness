/**
 * The risk policy is only a control if its inputs are. These pin where
 * execute_trade's numbers come from and that the dashboard escapes what it
 * renders. Both watched fail against the pre-fix code.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "../../integrations/trading/config.ts";
import { PAGE_HTML } from "../../integrations/trading/dashboard/page.ts";
import type { Broker } from "../../integrations/trading/src/broker.ts";
import {
  MODEL_INPUTS_REFUSAL,
  riskInputSource,
} from "../../integrations/trading/src/risk-inputs.ts";

const fakeBroker = {} as Broker;

describe("risk input source", () => {
  test("a code-level broker always wins", () => {
    expect(riskInputSource("http_code", fakeBroker, false)).toBe("broker");
    expect(riskInputSource("http_code", fakeBroker, true)).toBe("broker");
  });
  test("without a broker, model numbers need the explicit flag", () => {
    expect(riskInputSource("in_session", null, false)).toBe("refuse");
    expect(riskInputSource("none", null, false)).toBe("refuse");
    expect(riskInputSource("in_session", null, true)).toBe("model");
    // A backend that claims http_code but produced no client is not a broker.
    expect(riskInputSource("http_code", null, false)).toBe("refuse");
  });
  test("the flag defaults off and the refusal names it", () => {
    expect(Schema.parse({}).allow_model_supplied_risk_inputs).toBe(false);
    expect(MODEL_INPUTS_REFUSAL).toContain("allow_model_supplied_risk_inputs");
  });
  test("execute_trade routes through the decision", () => {
    const src = readFileSync(
      resolve(import.meta.dir, "../../integrations/trading/tools.ts"),
      "utf8",
    );
    const handler = src.slice(
      src.indexOf('name: "execute_trade"'),
      src.indexOf('name: "confirm_order"'),
    );
    expect(handler).toContain("riskInputSource(");
    expect(handler).toContain("MODEL_INPUTS_REFUSAL");
    expect(handler).not.toContain("broker: null, // in-session");
  });
});

describe("trading dashboard escapes what it renders", () => {
  const escSrc = PAGE_HTML.match(/function esc\(s\)\{[^\n]*\}/)?.[0];
  test("the helper exists and escapes markup characters", () => {
    expect(escSrc).toBeDefined();
    const esc = new Function(`${escSrc}; return esc;`)() as (s: unknown) => string;
    expect(esc("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(esc(`"quoted" & 'single'`)).toBe("&quot;quoted&quot; &amp; &#39;single&#39;");
    expect(esc(undefined)).toBe("");
    expect(esc(12.5)).toBe("12.5");
  });
  test("every model- or broker-controlled field is wrapped", () => {
    const fields = [
      "x.symbol",
      "x.quantity",
      "o.symbol",
      "o.side",
      "o.status",
      "o.qty",
      "p.version",
      "t.symbol",
      "t.direction",
      "x.wakeSource",
      "x.verdict",
      "a.actor",
      "a.event",
      "l.maxPctPerName",
      "l.maxPositionUSD",
      "l.dailyLossLimitUSD",
      "l.cashFloorUSD",
      "l.maxTradesPerDay",
    ];
    for (const f of fields) {
      expect(PAGE_HTML).not.toContain(`\${${f}}`);
      expect(PAGE_HTML).toContain(`esc(${f}`);
    }
    expect(PAGE_HTML).toContain("esc(p.vision||'')");
    expect(PAGE_HTML).toContain("esc(t.note||'')");
    expect(PAGE_HTML).toContain("esc(a.detail||'')");
    expect(PAGE_HTML).toContain("esc((x.thesis||'').slice(0,300))");
    expect(PAGE_HTML).toContain("esc(d.live.error)");
    expect(PAGE_HTML).toContain("'+esc(e)+'");
    expect(PAGE_HTML).not.toContain("'+e+'");
  });
});
