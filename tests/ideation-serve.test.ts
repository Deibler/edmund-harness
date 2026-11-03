import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageCheck } from "../src/ideation/page-check.ts";
import { publishIdeation, withPreviewTags } from "../src/ideation/publish.ts";
import { IDEATION_CSP, serveIdeation } from "../src/ideation/serve.ts";
import { IdeationStore, ideationsDir, newIdeationId } from "../src/ideation/store.ts";

const ORIGIN = "https://pages.example.com";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IMESSAGE_PREVIEW =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const pass = async (): Promise<PageCheck> => ({ ok: true, problems: [], screenshot: JPEG });
const fail = async (): Promise<PageCheck> => ({
  ok: false,
  problems: ["left accent border on div"],
  screenshot: null,
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "ideation-serve-"));
  const store = new IdeationStore(dataDir);
  const id = newIdeationId();
  store.create({
    id,
    sessionKey: "imessage:dm:+15550100001",
    thread: "the night sky",
    threadKey: "the night sky",
    title: 'Sunset "Compass"',
    pitch: "Where the sun sets from each of your spots.",
    why: "Asked on 8 days.",
    brief: "Build it.",
    evidence: [1, 2, 3],
    days: ["2026-10-24", "2026-10-27", "2026-10-30"],
    createdMs: 1_000,
  });
  const built = join(dataDir, "built.html");
  writeFileSync(
    built,
    "<!doctype html><html><head><title>Sunset Compass</title></head><body>hi</body></html>",
  );
  const deps = (check = pass) => ({ store, dataDir, origin: ORIGIN, check });
  const get = (path: string, init: RequestInit & { ua?: string } = {}) =>
    serveIdeation(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers: { "user-agent": init.ua ?? IPHONE },
      }),
      dataDir,
      store,
    );
  return { dataDir, store, id, built, deps, get };
}

describe("publishIdeation", () => {
  test("a page that fails its check is not published and stays building", async () => {
    const s = setup();
    const r = await publishIdeation(s.deps(fail), s.id, s.built);
    expect(r).toEqual({ ok: false, problems: ["left accent border on div"] });
    expect(s.store.get(s.id)?.status).toBe("building");
    expect(existsSync(join(ideationsDir(s.dataDir), s.id, "index.html"))).toBe(false);
  });

  test("a page that passes is written with its picture, then marked ready", async () => {
    const s = setup();
    const r = await publishIdeation(s.deps(), s.id, s.built, 5_000);
    expect(r).toEqual({ ok: true, url: `${ORIGIN}/i/${s.id}/` });
    const dir = join(ideationsDir(s.dataDir), s.id);
    expect(readFileSync(join(dir, "thumb.jpg"))).toEqual(JPEG);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/i/${s.id}/thumb.jpg">`);
    expect(html).toContain('content="Sunset &quot;Compass&quot;"');
    expect(s.store.get(s.id)).toMatchObject({ status: "ready", readyMs: 5_000 });
  });

  test("it publishes once", async () => {
    const s = setup();
    await publishIdeation(s.deps(), s.id, s.built);
    const again = await publishIdeation(s.deps(), s.id, s.built);
    expect(again.ok).toBe(false);
  });

  test("a page's own preview tags are kept", () => {
    const html = '<html><head><meta property="og:title" content="Mine"></head></html>';
    expect(withPreviewTags(html, { title: "x", description: "y", imageUrl: null })).toBe(html);
  });
});

describe("serveIdeation", () => {
  // The files are put on disk by hand: a page a builder wrote straight into
  // place, skipping the check, must still not be served. (Without the files
  // this would pass for the wrong reason, a missing file.)
  const writeUnchecked = (dataDir: string, id: string) => {
    const dir = join(ideationsDir(dataDir), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html><body>unchecked</body></html>");
    writeFileSync(join(dir, "thumb.jpg"), JPEG);
  };

  test("a page on disk is not served until the check marks it ready", () => {
    const s = setup();
    writeUnchecked(s.dataDir, s.id);
    expect(s.get(`/i/${s.id}/`)?.status).toBe(404);
    expect(s.get(`/i/${s.id}/thumb.jpg`)?.status).toBe(404);
  });

  test("a ready page is served under the sandbox, and an open is counted", async () => {
    const s = setup();
    await publishIdeation(s.deps(), s.id, s.built);
    const res = s.get(`/i/${s.id}/`);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-security-policy")).toBe(IDEATION_CSP);
    expect(IDEATION_CSP).toContain("sandbox allow-scripts");
    expect(IDEATION_CSP).not.toContain("allow-same-origin");
    expect(IDEATION_CSP).toContain("connect-src 'none'");
    expect(res?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res?.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res?.text()).toContain("Sunset Compass");
    expect(s.store.get(s.id)?.opens).toBe(1);
  });

  test("iMessage drawing the link preview, a HEAD and the picture are not opens", async () => {
    const s = setup();
    await publishIdeation(s.deps(), s.id, s.built);
    expect(s.get(`/i/${s.id}/`, { ua: IMESSAGE_PREVIEW })?.status).toBe(200);
    expect(s.get(`/i/${s.id}/`, { method: "HEAD" })?.status).toBe(200);
    const thumb = s.get(`/i/${s.id}/thumb.jpg`);
    expect(thumb?.headers.get("content-type")).toBe("image/jpeg");
    expect(s.store.get(s.id)?.opens).toBe(0);
  });

  test("the bare id redirects to the page, by path so the scheme stays https", async () => {
    const s = setup();
    await publishIdeation(s.deps(), s.id, s.built);
    // The tunnel hands the host plain http; the redirect must not echo it.
    const res = serveIdeation(new Request(`http://127.0.0.1:4795/i/${s.id}`), s.dataDir, s.store);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe(`/i/${s.id}/`);
  });

  test("only the page and its picture exist; everything else is a 404", async () => {
    const s = setup();
    await publishIdeation(s.deps(), s.id, s.built);
    for (const path of [
      `/i/${s.id}/index.html`,
      `/i/${s.id}/thumb.jpg/x`,
      `/i/${s.id.toUpperCase()}/`,
      "/i/not-an-id/",
      `/i/${s.id}/%2e%2e/%2e%2e/ideations.db`,
      "/i/",
    ]) {
      const res = s.get(path);
      expect(res === null || res.status === 404).toBe(true);
    }
    expect(s.get(`/i/${s.id}/`, { method: "POST" })?.status).toBe(404);
  });

  test("a failed build is never served", async () => {
    const s = setup();
    writeUnchecked(s.dataDir, s.id);
    s.store.markFailed(s.id, "the builder gave up");
    expect(s.get(`/i/${s.id}/`)?.status).toBe(404);
  });

  test("paths outside /i/ fall through to the rest of the host", () => {
    const s = setup();
    expect(s.get("/shelf/abc/")).toBeNull();
    expect(s.get("/index")).toBeNull();
  });
});
