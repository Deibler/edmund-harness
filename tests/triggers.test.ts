import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { triggerTools } from "../src/mcp/tools/triggers.ts";
import { evaluateTrigger, probeUrl } from "../src/triggers/evaluate.ts";
import { DataTriggerStore, type TriggerSource } from "../src/triggers/store.ts";
import {
  DataTriggerWatcher,
  PERSISTENT_FAILURE_ALERT_AT,
  PERSISTENT_FAILURE_DISARM_AT,
  buildFireEvent,
  effectiveIntervalMs,
} from "../src/triggers/watcher.ts";
/**
 * Model-authored data triggers: predicate evaluation with persistent
 * state, watcher fire/cooldown/expiry semantics, and the set_trigger
 * tool's validate-on-create behavior.
 */
import type { guardedFetch } from "../src/web/fetch.ts";
import { SsrfBlockedError } from "../src/web/ssrf.ts";

const KEY = "imessage:dm:+15550100001";
const URL_SOURCE: TriggerSource = { kind: "url", url: "https://example.test/data" };

function textOf(result: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return (result as any).content.map((c: any) => c.text).join("\n");
}

describe("evaluateTrigger", () => {
  test("boolean predicate", async () => {
    const probe = async () => ({ n: 5 });
    const r = await evaluateTrigger(URL_SOURCE, "return data.n > 3;", {}, probe);
    expect(r.fire).toBe(true);
    const r2 = await evaluateTrigger(URL_SOURCE, "return data.n > 9;", {}, probe);
    expect(r2.fire).toBe(false);
  });

  test("object predicate with summary, and persistent state dedupes", async () => {
    const probe = async () => ({ alerts: [{ id: "a1", headline: "Tornado Warning" }] });
    const predicate = `
      state.seen = state.seen || {};
      const fresh = data.alerts.filter(a => !state.seen[a.id]);
      for (const a of data.alerts) state.seen[a.id] = true;
      return { fire: fresh.length > 0, summary: fresh.map(a => a.headline).join("; ") };
    `;
    const r1 = await evaluateTrigger(URL_SOURCE, predicate, {}, probe);
    expect(r1.fire).toBe(true);
    expect(r1.summary).toContain("Tornado Warning");
    // Same data, state carried forward → no refire.
    const r2 = await evaluateTrigger(URL_SOURCE, predicate, r1.state, probe);
    expect(r2.fire).toBe(false);
  });

  test("throwing predicate propagates", async () => {
    const probe = async () => ({});
    await expect(evaluateTrigger(URL_SOURCE, "throw new Error('bad');", {}, probe)).rejects.toThrow(
      "bad",
    );
  });

  test("runaway predicate is killed at the timeout instead of hanging", async () => {
    // Pre-sandbox, `while (true) {}` ran synchronously on the daemon's own
    // event loop — one bad predicate froze every session until manual restart.
    const probe = async () => ({});
    await expect(
      evaluateTrigger(URL_SOURCE, "while (true) {}", {}, probe, { timeoutMs: 1_500 }),
    ).rejects.toThrow(/timed out/);
  }, 15_000);
});

/** The tests below exercise retry logic against a loopback server, which the
 *  production path refuses on purpose (SSRF guard). Inject a plain fetch. */
const plainFetch = ((u: URL | string, init?: RequestInit) =>
  fetch(String(u), init)) as unknown as typeof guardedFetch;

describe("probeUrl guard", () => {
  test("the default path refuses a private address before any request", async () => {
    await expect(probeUrl("http://127.0.0.1:1/nope")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("probeUrl", () => {
  test("retries once past a transient server failure", async () => {
    // IEM's LSR feed under storm load: the first response fails, the next is
    // fine. Pre-retry, that single blip counted as a check failure and walked
    // the trigger toward backoff and the 3:46am persistent-failure alert.
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return hits === 1 ? new Response("busy", { status: 503 }) : Response.json({ features: [] });
      },
    });
    try {
      const data = await probeUrl(`http://127.0.0.1:${server.port}/lsr.geojson`, undefined, {
        fetchImpl: plainFetch,
      });
      expect(hits).toBe(2);
      expect(data).toEqual({ features: [] });
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("a 4xx is the request's fault and is not retried", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response("nope", { status: 404 });
      },
    });
    try {
      await expect(
        probeUrl(`http://127.0.0.1:${server.port}/gone`, undefined, { fetchImpl: plainFetch }),
      ).rejects.toThrow("HTTP 404");
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("DataTriggerWatcher", () => {
  let dir: string;
  let store: DataTriggerStore;
  let fired: Array<{ sessionKey: string; event: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trg-"));
    store = new DataTriggerStore(dir);
    fired = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeWatcher(probeData: () => unknown) {
    return new DataTriggerWatcher({
      store,
      intervalMs: 999_999,
      probe: async () => probeData(),
      fire: (sessionKey, event) => fired.push({ sessionKey, event }),
    });
  }

  function arm(over: Partial<Parameters<DataTriggerStore["create"]>[0]> = {}) {
    return store.create({
      sessionKey: KEY,
      name: "test watch",
      brief: "tell Jordan when n exceeds 3",
      source: URL_SOURCE,
      predicate: "return { fire: data.n > 3, summary: 'n=' + data.n };",
      oneShot: false,
      checkIntervalMs: 0,
      cooldownMs: 60_000,
      expiresMs: null,
      ...over,
    });
  }

  test("fires into the owning session with brief + summary, one-shot goes done", async () => {
    const t = arm({ oneShot: true });
    const w = makeWatcher(() => ({ n: 5 }));
    await w.tick(1_000_000);
    expect(fired.length).toBe(1);
    expect(fired[0]!.sessionKey).toBe(KEY);
    expect(fired[0]!.event).toContain("Trigger fired: test watch");
    expect(fired[0]!.event).toContain("tell Jordan when n exceeds 3");
    expect(fired[0]!.event).toContain("n=5");
    expect(store.get(t.id)?.status).toBe("done");
    // Done triggers are no longer evaluated.
    await w.tick(2_000_000);
    expect(fired.length).toBe(1);
  });

  test("cooldown suppresses refire but state still advances; refires after", async () => {
    const t = arm(); // recurring, 60s cooldown
    const w = makeWatcher(() => ({ n: 9 }));
    await w.tick(1_000_000);
    expect(fired.length).toBe(1);
    await w.tick(1_030_000); // within cooldown
    expect(fired.length).toBe(1);
    expect(store.get(t.id)?.status).toBe("armed");
    await w.tick(1_070_000); // past cooldown
    expect(fired.length).toBe(2);
  });

  test("probe errors are recorded on the trigger, loop survives", async () => {
    const t = arm();
    const w = new DataTriggerWatcher({
      store,
      intervalMs: 999_999,
      probe: async () => {
        throw new Error("ECONNREFUSED somewhere");
      },
      fire: (sessionKey, event) => fired.push({ sessionKey, event }),
    });
    await w.tick(1_000_000);
    expect(fired.length).toBe(0);
    expect(store.get(t.id)?.lastError).toContain("ECONNREFUSED");
  });

  test("expiry sweep retires past-deadline triggers without firing", async () => {
    const t = arm({ expiresMs: 500_000 });
    const w = makeWatcher(() => ({ n: 9 }));
    await w.tick(1_000_000);
    expect(store.get(t.id)?.status).toBe("expired");
    expect(fired.length).toBe(0);
  });

  test("per-trigger check interval is honored", async () => {
    const t = arm({ checkIntervalMs: 300_000, oneShot: false, cooldownMs: 0 });
    const w = makeWatcher(() => ({ n: 9 }));
    await w.tick(1_000_000);
    expect(fired.length).toBe(1);
    await w.tick(1_100_000); // 100s later — under the 300s check interval
    expect(fired.length).toBe(1);
    await w.tick(1_400_000);
    expect(fired.length).toBe(2);
    expect(store.get(t.id)?.fireCount).toBe(2);
  });

  test("failing triggers back off exponentially and reset on success", async () => {
    const t = arm({ checkIntervalMs: 60_000, cooldownMs: 0 });
    let fail = true;
    const w = new DataTriggerWatcher({
      store,
      intervalMs: 999_999,
      probe: async () => {
        if (fail) throw new Error("boom");
        return { n: 9 };
      },
      fire: (sessionKey, event) => fired.push({ sessionKey, event }),
    });
    await w.tick(1_000_000); // failure #1
    expect(store.get(t.id)?.consecutiveFailures).toBe(1);
    await w.tick(1_070_000); // 70s later — within the 120s backoff, skipped
    expect(store.get(t.id)?.consecutiveFailures).toBe(1);
    await w.tick(1_130_000); // past backoff → failure #2
    expect(store.get(t.id)?.consecutiveFailures).toBe(2);
    fail = false;
    await w.tick(1_400_000); // past the 240s backoff → clean check resets + fires
    expect(store.get(t.id)?.consecutiveFailures).toBe(0);
    expect(store.get(t.id)?.lastError).toBeNull();
    expect(fired.length).toBe(1);
  });

  test("effectiveIntervalMs grows exponentially, caps at 1h, never undercuts the base cadence", () => {
    const t = { checkIntervalMs: 60_000, consecutiveFailures: 0 } as Parameters<
      typeof effectiveIntervalMs
    >[0];
    expect(effectiveIntervalMs(t)).toBe(60_000);
    expect(effectiveIntervalMs({ ...t, consecutiveFailures: 1 })).toBe(120_000);
    expect(effectiveIntervalMs({ ...t, consecutiveFailures: 3 })).toBe(480_000);
    expect(effectiveIntervalMs({ ...t, consecutiveFailures: 12 })).toBe(3_600_000);
    // A slow-cadence trigger keeps its own interval as the floor AND ceiling.
    expect(effectiveIntervalMs({ ...t, checkIntervalMs: 7_200_000, consecutiveFailures: 4 })).toBe(
      7_200_000,
    );
  });

  test("persistent failures escalate exactly once, at the threshold", async () => {
    arm({ checkIntervalMs: 0 }); // zero cadence → every tick is due, even backing off
    const escalations: number[] = [];
    const w = new DataTriggerWatcher({
      store,
      intervalMs: 999_999,
      probe: async () => {
        throw new Error("dead endpoint");
      },
      fire: (sessionKey, event) => fired.push({ sessionKey, event }),
      onPersistentFailure: (_t, _err, failures) => escalations.push(failures),
    });
    for (let i = 1; i <= PERSISTENT_FAILURE_ALERT_AT + 2; i++) await w.tick(i * 1_000);
    expect(escalations).toEqual([PERSISTENT_FAILURE_ALERT_AT]);
  });

  test("a permanently dead trigger is disarmed instead of probed forever", async () => {
    const t = arm({ checkIntervalMs: 0 });
    const disarms: number[] = [];
    const w = new DataTriggerWatcher({
      store,
      intervalMs: 999_999,
      probe: async () => {
        throw new Error("Was there a typo in the url or port?");
      },
      fire: (sessionKey, event) => fired.push({ sessionKey, event }),
      onAutoDisarm: (_t, _err, failures) => disarms.push(failures),
    });
    for (let i = 1; i <= PERSISTENT_FAILURE_DISARM_AT + 5; i++) await w.tick(i * 1_000);

    // Announced once, at the threshold — not on every later tick.
    expect(disarms).toEqual([PERSISTENT_FAILURE_DISARM_AT]);
    // And it is genuinely off: no longer armed, so it is never checked again.
    expect(store.get(t.id)?.status).not.toBe("armed");
    expect(store.listArmed().map((x) => x.id)).not.toContain(t.id);
  });

  test("a trigger already past the disarm line is still caught", async () => {
    // The three live kitchen triggers were at 100+ failures when the
    // terminal state shipped; an `=== N` check would have skipped them.
    const t = arm({ checkIntervalMs: 0 });
    for (let i = 0; i < PERSISTENT_FAILURE_DISARM_AT + 40; i++) {
      store.markChecked(t.id, i, undefined, "stale endpoint");
    }
    expect(store.get(t.id)!.consecutiveFailures).toBeGreaterThan(PERSISTENT_FAILURE_DISARM_AT);

    const w = new DataTriggerWatcher({
      store,
      intervalMs: 999_999,
      probe: async () => {
        throw new Error("still dead");
      },
      fire: (sessionKey, event) => fired.push({ sessionKey, event }),
    });
    await w.tick(10_000_000);
    expect(store.get(t.id)?.status).not.toBe("armed");
  });

  test("weather playbook rides only on weather-ish triggers", () => {
    // arm() defaults: example.test URL, "test watch"/"n exceeds 3" — generic.
    const generic = arm();
    expect(buildFireEvent(generic, "sum", "armed")).not.toContain("RadarOmega");
    const byUrl = arm({
      source: { kind: "url", url: "https://api.weather.gov/alerts/active?area=PA" },
    });
    expect(buildFireEvent(byUrl, "sum", "armed")).toContain("RadarOmega");
    const byAppJs = arm({ source: { kind: "app_js", expression: "1" } });
    expect(buildFireEvent(byAppJs, "sum", "armed")).toContain("RadarOmega");
  });
});

describe("set_trigger tool", () => {
  let dir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trg-tool-"));
    ctx = {
      sessionKey: KEY,
      dataDir: dir,
      config: {
        radaromega: { cdp_port: 9 },
        security: { model_host_access: "full" },
      } as unknown as Config,
    } as unknown as ToolContext;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function tool(name: string) {
    const t = triggerTools(ctx).find((t) => t.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }

  test("a sandboxed deployment refuses to arm any trigger", async () => {
    const boxed = {
      ...ctx,
      config: { radaromega: { cdp_port: 9 } } as unknown as Config,
    } as unknown as ToolContext;
    const tool = triggerTools(boxed).find((t) => t.name === "set_trigger")!;
    const r = await tool.handler({
      name: "x",
      source_url: "https://example.com/feed",
      predicate: "return false",
      interval_minutes: 5,
    } as never);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("model_host_access");
  });

  test("requires exactly one source", async () => {
    const set = tool("set_trigger");
    const r = await set.handler(
      set.inputSchema.parse({ name: "x", brief: "b", predicate: "return false;" }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((r as any).isError).toBe(true);
    expect(textOf(r)).toContain("exactly one");
  });

  test("first-check failure refuses to arm; bad URL never reaches the store", async () => {
    const set = tool("set_trigger");
    const r = await set.handler(
      set.inputSchema.parse({
        name: "broken",
        brief: "b",
        source_url: "http://127.0.0.1:1/nope",
        predicate: "return true;",
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((r as any).isError).toBe(true);
    expect(textOf(r)).toContain("NOT armed");
    const s = new DataTriggerStore(dir);
    expect(s.listBySession(KEY).length).toBe(0);
    s.close();
  });

  test("global armed cap refuses new triggers before probing", async () => {
    const s = new DataTriggerStore(dir);
    for (let i = 0; i < 80; i++) {
      s.create({
        sessionKey: `imessage:dm:+1555099${String(i).padStart(4, "0")}`,
        name: `t${i}`,
        brief: "b",
        source: URL_SOURCE,
        predicate: "return false;",
        oneShot: false,
        checkIntervalMs: 60_000,
        cooldownMs: 0,
        expiresMs: null,
      });
    }
    s.close();
    const set = tool("set_trigger");
    // The URL is unreachable on purpose — the cap must reject before probing.
    const r = await set.handler(
      set.inputSchema.parse({
        name: "one more",
        brief: "b",
        source_url: "http://127.0.0.1:1/nope",
        predicate: "return true;",
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    expect((r as any).isError).toBe(true);
    expect(textOf(r)).toContain("across all chats");
  });

  test("buildFireEvent carries id, brief, and standing-vs-done guidance", () => {
    const s = new DataTriggerStore(dir);
    const t = s.create({
      sessionKey: KEY,
      name: "n",
      brief: "the promise",
      source: URL_SOURCE,
      predicate: "return true;",
      oneShot: false,
      checkIntervalMs: 1,
      cooldownMs: 1,
      expiresMs: null,
    });
    const ev = buildFireEvent(t, "sum", "armed");
    expect(ev).toContain(t.id);
    expect(ev).toContain("the promise");
    expect(ev).toContain("cancel_trigger");
    const done = buildFireEvent(t, "sum", "done");
    expect(done).toContain("one-shot");
    s.close();
  });
});
