/**
 * The voice lab: the page's side of a call (WebProvider), the locks on its
 * server, and the voice setting it writes for every call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LabLink, WebProvider } from "../src/calls/providers/web/provider.ts";
import { LabServer, isPrivateAddress } from "../src/calls/providers/web/server.ts";
import type { ProviderEvent } from "../src/calls/types.ts";
import { VoiceSettingsStore, validVoiceSettings } from "../src/calls/voice-settings.ts";

const OPERATOR = "+15550100001";
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

class FakeLink implements LabLink {
  sent: Record<string, unknown>[] = [];
  audio: Uint8Array[] = [];
  closed = false;
  send(message: Record<string, unknown>) {
    this.sent.push(message);
  }
  sendAudio(pcm: Uint8Array) {
    this.audio.push(pcm);
  }
  close() {
    this.closed = true;
  }
  states() {
    return this.sent.filter((m) => m.type === "state").map((m) => m.state);
  }
}

function talk(ms: number): Int16Array {
  const out = new Int16Array(ms * 16);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((Math.random() * 2 - 1) * 5_000);
  return out;
}

describe("WebProvider", () => {
  let events: ProviderEvent[];
  let transcribed: number;
  let busy: string | null;
  let lab: WebProvider;
  let page: FakeLink;

  beforeEach(async () => {
    events = [];
    transcribed = 0;
    busy = null;
    lab = new WebProvider({
      peer: () => ({ kind: "person", handle: OPERATOR }),
      transcribe: async () => {
        transcribed += 1;
        return { text: "hello" };
      },
      turnVerdict: async () => 0.9,
      busy: () => busy,
      ringTimeoutMs: 80,
      readyTimeoutMs: 80,
    });
    await lab.start((e) => events.push(e));
    page = new FakeLink();
    lab.attach(page);
  });

  const calls = () =>
    events.flatMap((e) => (e.type === "call" ? [`${e.call.state}:${e.call.id}`] : []));
  const callId = () => (events.find((e) => e.type === "call") as { call: { id: string } }).call.id;

  test("a call from the page rings as the operator, and is live once answered", async () => {
    lab.message(page, { type: "call" });
    expect(page.states()).toEqual(["idle", "ringing"]);
    const ring = events.find((e) => e.type === "call")!;
    expect(ring.type === "call" && ring.call.peer).toEqual({ kind: "person", handle: OPERATOR });
    await lab.answer(callId());
    expect(page.states().at(-1)).toBe("active");
    expect(calls()).toEqual([`ringing:${callId()}`, `active:${callId()}`]);
  });

  test("Edmund's audio is ready only once the page says it is playing", async () => {
    lab.message(page, { type: "call" });
    await lab.answer(callId());
    let settled: unknown = null;
    void lab.audioReady().then((r) => {
      settled = r;
    });
    await tick();
    expect(settled).toBeNull();
    lab.message(page, { type: "ready" });
    await tick();
    expect(settled).toEqual({ ok: true });
  });

  test("a page whose audio never starts is reported, not waited on forever", async () => {
    lab.message(page, { type: "call" });
    await lab.answer(callId());
    const ready = await lab.audioReady();
    expect(ready.ok).toBe(false);
  });

  test("each chunk is reported once: played when the page played it, unplayed when flushed", async () => {
    lab.message(page, { type: "call" });
    await lab.answer(callId());
    await lab.say("c1", new Uint8Array(4), 24_000);
    await lab.say("c2", new Uint8Array(4), 24_000);
    expect(page.sent.filter((m) => m.type === "chunk").map((m) => m.id)).toEqual(["c1", "c2"]);
    expect(page.audio.length).toBe(2);
    lab.message(page, { type: "played", id: "c1" });
    lab.message(page, { type: "played", id: "c1" });
    await lab.flush();
    // A play report that arrives after the flush does not count twice.
    lab.message(page, { type: "played", id: "c2" });
    const spoken = events.filter((e) => e.type === "spoken");
    expect(spoken).toEqual([
      { type: "spoken", chunkId: "c1", played: true },
      { type: "spoken", chunkId: "c2", played: false },
    ]);
    expect(page.sent.at(-1)).toEqual({ type: "flush" });
  });

  test("the caller is heard only while the call is up and listening", async () => {
    lab.message(page, { type: "call" });
    lab.audio(page, talk(1_000));
    await tick();
    expect(transcribed).toBe(0);
    await lab.answer(callId());
    await lab.listen();
    lab.audio(page, talk(1_000));
    await tick();
    expect(transcribed).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "speech")).toBe(true);
  });

  test("closing the page ends the call", async () => {
    lab.message(page, { type: "call" });
    await lab.answer(callId());
    lab.detach(page);
    expect(calls().at(-1)).toBe(`ended:${callId()}`);
  });

  test("a call Edmund does not pick up ends, and the page is told why", async () => {
    lab.message(page, { type: "call" });
    await tick(120);
    expect(calls().at(-1)).toBe(`ended:${callId()}`);
    expect(page.sent.at(-1)).toMatchObject({ state: "ended", reason: "Edmund did not pick up" });
  });

  test("while Edmund is on another call, the page is told and nothing rings", () => {
    busy = "Edmund is on a FaceTime call";
    lab.message(page, { type: "call" });
    expect(calls()).toEqual([]);
    expect(page.sent.at(-1)).toMatchObject({ state: "ended", reason: busy });
  });

  test("a second page takes over: the first is told, closed, and its call ended", async () => {
    lab.message(page, { type: "call" });
    await lab.answer(callId());
    const second = new FakeLink();
    lab.attach(second);
    expect(page.closed).toBe(true);
    expect(page.sent.at(-1)).toMatchObject({ state: "ended" });
    expect(calls().at(-1)).toBe(`ended:${callId()}`);
    // The old page no longer drives anything...
    lab.message(page, { type: "call" });
    expect(calls().filter((c) => c.startsWith("ringing")).length).toBe(1);
    // ...and its microphone is not heard on the new page's call.
    lab.message(second, { type: "call" });
    const next = (events.findLast((e) => e.type === "call") as { call: { id: string } }).call.id;
    await lab.answer(next);
    await lab.listen();
    lab.audio(page, talk(1_000));
    await tick();
    expect(transcribed).toBe(0);
    lab.audio(second, talk(1_000));
    await tick();
    expect(transcribed).toBeGreaterThan(0);
  });

  test("Edmund cannot dial out through the lab", async () => {
    await expect(lab.dial()).rejects.toThrow();
  });
});

describe("isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.9", true],
    ["172.31.255.1", true],
    ["192.168.1.20", true],
    ["169.254.3.4", true],
    ["::1", true],
    ["::ffff:192.168.1.20", true],
    ["fe80::1c2a:3bff:fe4d:1", true],
    ["fd12:3456::1", true],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["::ffff:8.8.8.8", false],
    ["2001:db8::1", false],
    ["100.64.0.1", false],
    ["", false],
  ])("%s -> %p", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe("LabServer", () => {
  let dir: string;
  let server: LabServer;
  let base: string;
  let key: string;
  let saved: VoiceSettingsStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "edmund-voice-lab-"));
    saved = new VoiceSettingsStore(join(dir, "voice.json"), { voice: "bm_daniel", speed: 1 });
    const provider = new WebProvider({
      peer: () => ({ kind: "person", handle: OPERATOR }),
      transcribe: async () => ({ text: "" }),
      turnVerdict: async () => null,
      busy: () => null,
    });
    await provider.start(() => {});
    server = new LabServer({
      port: 0,
      hostname: "127.0.0.1",
      dir,
      provider,
      settings: saved,
      voices: async () => ["am_michael", "bm_daniel", "bm_george"],
      synthesize: async () => ({ pcm: new Uint8Array(480), sampleRate: 24_000 }),
      insecure: true,
    });
    server.start();
    base = `http://127.0.0.1:${server.port()}`;
    key = readFileSync(join(dir, "key"), "utf8").trim();
  });

  afterEach(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const cookie = () => ({ cookie: `edmund_lab=${key}` });

  test("its key is made once, private to this user, and long", () => {
    expect(key.length).toBeGreaterThanOrEqual(32);
    const mode = Bun.spawnSync(["stat", "-f", "%Lp", join(dir, "key")])
      .stdout.toString()
      .trim();
    expect(mode).toBe("600");
  });

  test("without the key nothing is served", async () => {
    for (const path of ["/", "/api/voices", "/ws"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
    }
    const wrong = await fetch(`${base}/?key=${"0".repeat(key.length)}`, { redirect: "manual" });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  test("the key in the link becomes an HttpOnly, same-site cookie and leaves the address", async () => {
    const res = await fetch(`${base}/?key=${key}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain(`edmund_lab=${key}`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    const page = await fetch(`${base}/`, { headers: cookie() });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Edmund Voice Lab");
  });

  test("a page on another origin cannot use the cookie", async () => {
    const res = await fetch(`${base}/api/voices`, {
      headers: { ...cookie(), origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("a WebSocket without the cookie is refused, and with it is a call link", async () => {
    const refused = new WebSocket(`ws://127.0.0.1:${server.port()}/ws`);
    const outcome = await new Promise<string>((resolve) => {
      refused.onopen = () => resolve("open");
      refused.onerror = () => resolve("refused");
    });
    expect(outcome).toBe("refused");
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}/ws`, { headers: cookie() } as never);
    const first = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(String(e.data));
    });
    expect(JSON.parse(first)).toEqual({ type: "state", state: "idle" });
    ws.close();
  });

  test("the voice is saved only when it is a real voice at a sane speed", async () => {
    const put = (body: unknown) =>
      fetch(`${base}/api/voice`, {
        method: "PUT",
        headers: { ...cookie(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await put({ voice: "bm_nobody", speed: 1 })).status).toBe(400);
    expect((await put({ voice: "bm_daniel", speed: 3 })).status).toBe(400);
    expect((await put({ voice: "bm_daniel; rm -rf", speed: 1 })).status).toBe(400);
    expect(existsSync(join(dir, "voice.json"))).toBe(false);
    const ok = await put({ voice: "bm_daniel:0.7,am_michael:0.3", speed: 1.1 });
    expect(ok.status).toBe(200);
    expect(saved.get()).toEqual({ voice: "bm_daniel:0.7,am_michael:0.3", speed: 1.1 });
    const listed = (await (await fetch(`${base}/api/voices`, { headers: cookie() })).json()) as {
      current: unknown;
    };
    expect(listed.current).toEqual({ voice: "bm_daniel:0.7,am_michael:0.3", speed: 1.1 });
  });

  test("a preview comes back as a WAV of what was synthesised", async () => {
    const res = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { ...cookie(), "content-type": "application/json" },
      body: JSON.stringify({ voice: "bm_george", speed: 1, text: "Hello." }),
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(bytes.length).toBe(44 + 480);
  });
});

describe("VoiceSettingsStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-voice-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("absent or unreadable, a call speaks in the configured voice", () => {
    const path = join(dir, "calls", "voice.json");
    const store = new VoiceSettingsStore(path, { voice: "bm_daniel", speed: 1 });
    expect(store.get()).toEqual({ voice: "bm_daniel", speed: 1 });
    store.set({ voice: "bm_george", speed: 1.2 });
    expect(store.get()).toEqual({ voice: "bm_george", speed: 1.2 });
    writeFileSync(path, "{ not json");
    expect(store.get()).toEqual({ voice: "bm_daniel", speed: 1 });
  });

  test("a change on disk is picked up by the next sentence", async () => {
    const path = join(dir, "voice.json");
    const reader = new VoiceSettingsStore(path, { voice: "bm_daniel", speed: 1 });
    const writer = new VoiceSettingsStore(path, { voice: "bm_daniel", speed: 1 });
    writer.set({ voice: "am_michael", speed: 1 });
    expect(reader.get().voice).toBe("am_michael");
    await tick(20);
    writer.set({ voice: "bm_george", speed: 0.9 });
    expect(reader.get()).toEqual({ voice: "bm_george", speed: 0.9 });
  });

  test("validation", () => {
    expect(validVoiceSettings({ voice: "bm_daniel", speed: 1 }).ok).toBe(true);
    expect(validVoiceSettings({ voice: "bm_daniel:0.5,af_heart:.5", speed: 0.5 }).ok).toBe(true);
    expect(validVoiceSettings({ voice: "BM_DANIEL", speed: 1 }).ok).toBe(false);
    expect(validVoiceSettings({ voice: "bm_daniel,", speed: 1 }).ok).toBe(false);
    expect(validVoiceSettings({ voice: "bm_daniel", speed: "1" }).ok).toBe(false);
    expect(validVoiceSettings({ voice: "bm_daniel", speed: Number.NaN }).ok).toBe(false);
    expect(validVoiceSettings(null).ok).toBe(false);
  });
});
