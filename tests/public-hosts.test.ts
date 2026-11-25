/**
 * Two public names, each serving only its own; and the portal's listener
 * handing the router what is not the portal's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAccessLog } from "../src/util/access-log.ts";
import { readChannel } from "../src/util/log-files.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";
import { registerMount } from "../src/web/mounts.ts";
import {
  RELAY_HOST_HEADER,
  RELAY_KEY_HEADER,
  announceRouter,
  hostDecision,
  isArtifactPath,
  publicHostOf,
  readRouterAddress,
  relayToRouter,
} from "../src/web/public-hosts.ts";

const KITCHEN = "https://kitchen.example.com";
const PAGES = "https://pages.example.com";
const decide = (
  host: string,
  surface: "kitchen" | "artifact" | "none",
  over: Partial<Parameters<typeof hostDecision>[0]> = {},
) =>
  hostDecision({
    host,
    method: "GET",
    accept: "text/html,application/xhtml+xml",
    surface,
    pathAndQuery: "/games/2026-11-24/?round=2",
    kitchenOrigin: KITCHEN,
    artifactsOrigin: PAGES,
    ...over,
  });

describe("which name serves what", () => {
  test("each name serves its own", () => {
    expect(decide("kitchen.example.com", "kitchen")).toEqual({ action: "serve" });
    expect(decide("pages.example.com", "artifact")).toEqual({ action: "serve" });
    expect(decide("PAGES.example.com", "artifact")).toEqual({ action: "serve" });
  });

  test("a person who opens an old link at the kitchen's name is sent to where it lives now", () => {
    expect(decide("kitchen.example.com", "artifact")).toEqual({
      action: "redirect",
      to: "https://pages.example.com/games/2026-11-24/?round=2",
    });
    expect(decide("kitchen.example.com", "artifact", { method: "HEAD" }).action).toBe("redirect");
  });

  test("a program at the kitchen's name is answered where it asked", () => {
    // A webhook, a link preview, a page's own script: redirected, they just fail.
    expect(decide("kitchen.example.com", "artifact", { method: "POST" })).toEqual({
      action: "serve",
    });
    expect(decide("kitchen.example.com", "artifact", { accept: "text/event-stream" })).toEqual({
      action: "serve",
    });
    expect(decide("kitchen.example.com", "artifact", { accept: "*/*" })).toEqual({
      action: "serve",
    });
    expect(decide("kitchen.example.com", "artifact", { accept: null })).toEqual({
      action: "serve",
    });
  });

  test("the other name does not serve the kitchen", () => {
    expect(decide("pages.example.com", "kitchen")).toEqual({
      action: "redirect",
      to: "https://kitchen.example.com/games/2026-11-24/?round=2",
    });
    expect(decide("pages.example.com", "kitchen", { method: "POST" })).toEqual({
      action: "refuse",
    });
  });

  test("one name for both, or none set, or a request from this machine: as before", () => {
    expect(decide("kitchen.example.com", "artifact", { artifactsOrigin: KITCHEN })).toEqual({
      action: "serve",
    });
    expect(decide("kitchen.example.com", "artifact", { artifactsOrigin: null })).toEqual({
      action: "serve",
    });
    expect(decide("kitchen.example.com", "artifact", { artifactsOrigin: "" })).toEqual({
      action: "serve",
    });
    expect(decide("127.0.0.1:4795", "artifact")).toEqual({ action: "serve" });
    expect(decide("kitchen.example.com", "none")).toEqual({ action: "serve" });
  });
});

describe("handing over", () => {
  let dir = "";
  let logs = "";
  let router: ReturnType<typeof Bun.serve> | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "public-hosts-"));
    logs = join(dir, "logs");
    mkdirSync(logs);
    installLogSink(logs, "", "daemon.log", { echo: false, instrument: false });
  });
  afterEach(() => {
    router?.stop(true);
    router = null;
    uninstallLogSink();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the assistant's paths are told from the portal's own", () => {
    registerMount(dir, "/games/", 4797);
    expect(isArtifactPath(dir, "/shelf/0f66f61026db697ea6c05ccfc2aea69a/a.pdf")).toBe(true);
    expect(isArtifactPath(dir, "/i/abc/")).toBe(true);
    expect(isArtifactPath(dir, "/games/2026-11-24/")).toBe(true);
    for (const own of [
      "/u/key/token",
      "/pay/stripe",
      "/robots.txt",
      "/portal/assets/x.js",
      "/",
      "/index.html",
      "/gamesmanship",
    ]) {
      expect(isArtifactPath(dir, own)).toBe(false);
    }
  });

  test("the router's address and key are for this account only, and read back", () => {
    const announced = announceRouter(dir, 4795);
    expect(readRouterAddress(dir)).toEqual(announced);
    expect(announced.relayKey).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(join(dir, "run", "public-router.json")).mode & 0o777).toBe(0o600);
    expect(readRouterAddress(join(dir, "nowhere"))).toBeNull();
  });

  test("a relayed request reaches the router whole, is believed about its name, and is one visitor not two", async () => {
    let seen: { host: string | null; relayed: boolean; body: string; via: string | null } | null =
      null;
    let announced = { port: 0, relayKey: "" };
    router = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: withAccessLog(
        "router",
        async (req: Request) => {
          seen = {
            ...publicHostOf(req, announced.relayKey),
            body: await req.text(),
            via: req.headers.get("cf-connecting-ip"),
          };
          return new Response("the page", { status: 201, headers: { "x-from": "router" } });
        },
        { relayed: (req) => publicHostOf(req, announced.relayKey).relayed },
      ),
    });
    announced = announceRouter(dir, router.port ?? 0);

    // The portal's listener, as dashboard/server/main.ts wraps it.
    const door = withAccessLog("portal", (req: Request) =>
      relayToRouter(req, readRouterAddress(dir)!),
    );
    const res = await door(
      new Request("https://pages.example.com/games/2026-11-24/?round=2", {
        method: "POST",
        body: "a move",
        headers: {
          host: "pages.example.com",
          "cf-connecting-ip": "198.51.100.7",
          "user-agent": "Mozilla/5.0 Chrome/131.0 Safari/537.36",
        },
      }),
      { requestIP: () => ({ address: "127.0.0.1" }) },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-from")).toBe("router");
    expect(await res.text()).toBe("the page");
    // The mount behind the router still sees who is asking: its own limits depend on it.
    expect(seen).toEqual({
      host: "pages.example.com",
      relayed: true,
      body: "a move",
      via: "198.51.100.7",
    });

    const records = readChannel(logs, "net-in", 0);
    const atDoor = records.find((r) => r.fields!.server === "portal")!;
    const atRouter = records.find((r) => r.fields!.server === "router")!;
    expect(atDoor.fields).toMatchObject({ via: "198.51.100.7", status: 201 });
    expect(atRouter.fields).toMatchObject({ relayed: true, status: 201 });
    expect(atRouter.fields!.via).toBeUndefined();
    expect(
      readChannel(logs, "security", 0).filter((r) => r.fields!.kind === "new-client"),
    ).toHaveLength(1);

    // Six visitors each probing once is not one client scanning: the router
    // sees them all arrive from this machine, and leaves the judging to the door.
    for (let i = 0; i < 6; i++) {
      await door(
        new Request("https://pages.example.com/games/.env", {
          headers: { host: "pages.example.com", "cf-connecting-ip": `198.51.100.${20 + i}` },
        }),
        { requestIP: () => ({ address: "127.0.0.1" }) },
      );
    }
    const security = readChannel(logs, "security", 0);
    expect(security.filter((r) => r.fields!.server === "router")).toEqual([]);
    expect(
      security.filter((r) => r.fields!.kind === "probe" && r.fields!.server === "portal"),
    ).toHaveLength(6);
    expect(security.filter((r) => r.fields!.kind === "scan")).toEqual([]);
  });

  test("a request that only claims to be relayed is not believed", () => {
    const real = announceRouter(dir, 4795);
    const forged = new Request("http://127.0.0.1:4795/games/", {
      headers: {
        host: "kitchen.example.com",
        [RELAY_KEY_HEADER]: "not-the-key",
        [RELAY_HOST_HEADER]: "pages.example.com",
      },
    });
    expect(publicHostOf(forged, real.relayKey)).toEqual({
      host: "kitchen.example.com",
      relayed: false,
    });
    expect(publicHostOf(forged, null)).toEqual({ host: "kitchen.example.com", relayed: false });
  });
});
