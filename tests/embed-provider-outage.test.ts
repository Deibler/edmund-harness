import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EmbedHealthEvent,
  TransformersEmbedProvider,
  setEmbedHealthHook,
} from "../src/memory/embed-provider.ts";

// The outage this guards against (2026-10-30 to 2026-11-16): the embedder
// could not load its model, stayed that way until the daemon restarted, and
// nothing said so. Each test breaks the embedder the way that outage did.

const script = new URL("./fixtures/fake-embed-child.ts", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "embed-outage-"));
const brokenFlag = join(dir, "broken");
// The fake process reads this once, as it starts.
process.env.FAKE_EMBED_BROKEN = brokenFlag;
let provider: TransformersEmbedProvider;
let events: EmbedHealthEvent[] = [];

function make(alertAfter = { failures: 2, ms: 0 }): TransformersEmbedProvider {
  events = [];
  setEmbedHealthHook((event) => events.push(event));
  provider = new TransformersEmbedProvider("test-model", 2, script, 60_000, alertAfter);
  return provider;
}

const breakModel = () => writeFileSync(brokenFlag, "");
const repairModel = () => rmSync(brokenFlag, { force: true });
const pidOf = async (p: TransformersEmbedProvider) => (await p.embed(["pid"])).vectors[0]![1]!;
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return done();
}

afterEach(() => {
  provider?.trimIdleWorker();
  setEmbedHealthHook(null);
  repairModel();
});

describe("when the local embedder breaks", () => {
  test("a model that cannot load fails the call instead of hanging it", async () => {
    make();
    breakModel();
    await expect(provider.embed(["text 1"])).rejects.toThrow("Cannot find module");
    expect(provider.health().failures).toBe(1);
    expect(provider.health().lastError).toContain("Cannot find module");
  });

  test("the process that could not load is replaced, so the next call works", async () => {
    make();
    breakModel();
    await expect(provider.embed(["text 1"])).rejects.toThrow();
    // The broken process stays broken for life. Only a new one can answer.
    repairModel();
    expect((await provider.embed(["text 7"])).vectors[0]![1]).toBe(7);
    expect(provider.health()).toEqual({ failures: 0, failingSinceMs: null, lastError: null });
  });

  test("an outage is reported once, and so is its end", async () => {
    make({ failures: 2, ms: 0 });
    breakModel();
    await expect(provider.embed(["text 1"])).rejects.toThrow();
    expect(events).toEqual([]);
    await expect(provider.embed(["text 2"])).rejects.toThrow();
    await expect(provider.embedQuery(["text 3"])).rejects.toThrow();
    expect(events.map((e) => e.kind)).toEqual(["failing"]);
    expect(events[0]).toMatchObject({ model: "test-model", failures: 2 });
    expect(events[0]!.error).toContain("Cannot find module");

    repairModel();
    await provider.embed(["text 4"]);
    await provider.embed(["text 5"]);
    expect(events.map((e) => e.kind)).toEqual(["failing", "recovered"]);
    expect(events[1]!.failures).toBe(3);
  });

  test("a blip is not an outage", async () => {
    make({ failures: 3, ms: 0 });
    breakModel();
    await expect(provider.embed(["text 1"])).rejects.toThrow();
    repairModel();
    await provider.embed(["text 2"]);
    expect(events).toEqual([]);
  });

  test("failures close together are not yet an outage", async () => {
    make({ failures: 2, ms: 60_000 });
    breakModel();
    for (const n of [1, 2, 3]) await expect(provider.embed([`text ${n}`])).rejects.toThrow();
    expect(events).toEqual([]);
    expect(provider.health().failures).toBe(3);
  });

  test("a process that dies mid-request fails the request and is replaced", async () => {
    make();
    const first = await pidOf(provider);
    await expect(provider.embed(["crash"])).rejects.toThrow("embedding process exited");
    const second = await pidOf(provider);
    expect(second).not.toBe(first);
    expect(await until(() => gone(first), 2000)).toBe(true);
  });

  test("one bad request does not cost the loaded model", async () => {
    make();
    const first = await pidOf(provider);
    await expect(provider.embed(["bad input"])).rejects.toThrow("bad input");
    expect(await pidOf(provider)).toBe(first);
  });

  test("a hook that throws does not break embedding", async () => {
    make({ failures: 1, ms: 0 });
    setEmbedHealthHook(() => {
      throw new Error("alerting is down");
    });
    breakModel();
    await expect(provider.embed(["text 1"])).rejects.toThrow("Cannot find module");
    repairModel();
    expect((await provider.embed(["text 2"])).vectors.length).toBe(1);
  });
});

describe("the embedding process and its owner", () => {
  test("releasing the model ends the process", async () => {
    make();
    const pid = await pidOf(provider);
    expect(provider.trimIdleWorker()).toBe(true);
    expect(await until(() => gone(pid), 2000)).toBe(true);
  });

  test("the real embedding process does not outlive an owner that was killed", async () => {
    const owner = Bun.spawn(
      [process.execPath, new URL("./fixtures/embed-owner.ts", import.meta.url).pathname],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const reader = owner.stdout.getReader();
    const { value } = await reader.read();
    const childPid = Number(new TextDecoder().decode(value).trim());
    expect(childPid).toBeGreaterThan(1);
    expect(gone(childPid)).toBe(false);
    owner.kill("SIGKILL");
    await owner.exited;
    expect(await until(() => gone(childPid), 9000)).toBe(true);
  }, 15_000);

  test("an idle embedder does not hold a one-shot program open", async () => {
    const once = Bun.spawn(
      [process.execPath, new URL("./fixtures/embed-once.ts", import.meta.url).pathname],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = await Promise.race([
      once.exited,
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 5000)),
    ]);
    if (exited === "stuck") once.kill("SIGKILL");
    expect(exited).toBe(0);
    expect((await new Response(once.stdout).text()).trim()).toBe("5");
  }, 10_000);
});
