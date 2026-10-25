import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveShelf } from "../src/shelf/serve.ts";
import { shelfName, shelfRoot, shelfToken, shelveFile } from "../src/shelf/shelf.ts";

const dataDir = mkdtempSync(join(tmpdir(), "shelf-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const origin = "https://host.example.com";

const src = join(dataDir, "Study Kit (week 3).pdf");
writeFileSync(src, "0123456789abcdefghij");

describe("a person's shelf", () => {
  test("names are safe on disk and in a URL", () => {
    expect(shelfName("Study Kit (week 3).PDF")).toBe("Study-Kit-week-3.pdf");
    expect(shelfName("../../etc/passwd")).toBe("passwd");
    expect(shelfName(".hidden")).toBe("hidden");
  });

  test("each chat has one stable, unguessable token", () => {
    const a = shelfToken(dataDir, "dm:+15555550101");
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(shelfToken(dataDir, "dm:+15555550101")).toBe(a);
    expect(shelfToken(dataDir, "dm:+15555550102")).not.toBe(a);
  });

  test("shelving copies the file and returns a permanent link and the shelf page", () => {
    const r = shelveFile({
      dataDir,
      sessionKey: "dm:+15555550101",
      src,
      origin,
      title: "Week 3 kit",
    });
    const token = shelfToken(dataDir, "dm:+15555550101");
    expect(r.url).toBe(`${origin}/shelf/${token}/Study-Kit-week-3.pdf`);
    expect(r.shelfUrl).toBe(`${origin}/shelf/${token}/`);
    expect(readFileSync(r.path, "utf8")).toBe("0123456789abcdefghij");
    // The same file again keeps its name; a different file under it is numbered.
    expect(shelveFile({ dataDir, sessionKey: "dm:+15555550101", src, origin }).url).toBe(r.url);
    const other = join(dataDir, "other", "Study Kit (week 3).pdf");
    rmSync(join(dataDir, "other"), { recursive: true, force: true });
    mkdirSync(join(dataDir, "other"));
    writeFileSync(other, "different contents");
    expect(
      shelveFile({ dataDir, sessionKey: "dm:+15555550101", src: other, origin }).url,
    ).toEndWith("Study-Kit-week-3-2.pdf");
  });
});

describe("serving the shelf", () => {
  const token = () => shelfToken(dataDir, "dm:+15555550101");
  const get = (path: string, headers: Record<string, string> = {}) =>
    serveShelf(new Request(`http://localhost${path}`, { headers }), shelfRoot(dataDir));

  test("not a shelf path: falls through to the router", () => {
    expect(get("/?key=abc")).toBeNull();
  });

  test("the shelf page lists what is on it, newest first", async () => {
    const res = get(`/shelf/${token()}/`)!;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Week 3 kit");
    // Both entries are listed; the re-shelved one kept its title.
    expect(html).toContain("Study-Kit-week-3-2.pdf");
  });

  test("a file is served whole, and a byte range as 206", async () => {
    const whole = get(`/shelf/${token()}/Study-Kit-week-3.pdf`)!;
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe("0123456789abcdefghij");
    const part = get(`/shelf/${token()}/Study-Kit-week-3.pdf`, { range: "bytes=2-5" })!;
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/20");
    expect(await part.text()).toBe("2345");
    const tail = get(`/shelf/${token()}/Study-Kit-week-3.pdf`, { range: "bytes=-3" })!;
    expect(await tail.text()).toBe("hij");
  });

  test("anything else on a shelf path is a 404", () => {
    expect(get("/shelf/not-a-token/x.pdf")?.status).toBe(404);
    expect(get(`/shelf/${"0".repeat(32)}/x.pdf`)?.status).toBe(404);
    expect(get(`/shelf/${token()}/..%2Ftokens.json`)?.status).toBe(404);
    expect(get(`/shelf/${token()}/index.json`)?.status).toBe(404);
    expect(get(`/shelf/${token()}/.hidden`)?.status).toBe(404);
  });

  test("over real HTTP, a video player's range request gets 206", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => serveShelf(req, shelfRoot(dataDir)) ?? new Response("nf", { status: 404 }),
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/shelf/${token()}/Study-Kit-week-3.pdf`,
        {
          headers: { range: "bytes=0-1" },
        },
      );
      expect(res.status).toBe(206);
      expect(await res.text()).toBe("01");
    } finally {
      server.stop(true);
    }
  });

  test("the kitchen host mounts the shelf before its household routing", () => {
    const host = readFileSync(
      join(import.meta.dir, "..", "integrations/kitchen/scripts/host.ts"),
      "utf8",
    );
    expect(host.indexOf("serveShelf(req, shelfDir)")).toBeGreaterThan(0);
    expect(host.indexOf("serveShelf(req, shelfDir)")).toBeLessThan(
      host.indexOf("route(url, current)"),
    );
  });
});
