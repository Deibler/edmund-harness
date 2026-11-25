/**
 * Which public name serves what.
 *
 * A deployment can have two: the kitchen's (`[kitchen] site_origin`), for
 * household recipe and inventory pages, and one for everything else the
 * assistant hands people (`[shelf] origin`): shelf links, the pages it builds,
 * and whatever is mounted on the public router. When they are the same name,
 * or one is not set, nothing here does anything.
 *
 * When they differ, each name serves only its own. A person who opens an old
 * link on the other name is sent to the right one; a program (a webhook, a
 * link preview, a script fetching JSON) is answered where it asked, because
 * a program that is redirected often just fails.
 *
 * The second name need not reach the router itself. It can be the portal's:
 * the portal's listener hands the router any request for something that is
 * not its own (`relayToRouter`), and says so with a key only this machine
 * has, so that the router believes which name the request came to and does
 * not count it a second time as a visitor.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { mountFor } from "./mounts.ts";

/** Carries the key that proves a request was handed over by the portal's listener. */
export const RELAY_KEY_HEADER = "x-edmund-relay";
/** The public name the request first arrived at, when it was handed over. */
export const RELAY_HOST_HEADER = "x-edmund-public-host";

/** True for a path that is the assistant's to serve, not the kitchen's: a shelf link, a built page, a mount. */
export function isArtifactPath(dataDir: string, pathname: string): boolean {
  if (pathname.startsWith("/shelf/")) return true;
  if (pathname === "/i" || pathname.startsWith("/i/")) return true;
  return mountFor(dataDir, pathname) !== null;
}

export type RouterAddress = { port: number; relayKey: string };

const addressFile = (dataDir: string) => join(dataDir, "run", "public-router.json");

/** The router says where it is and mints the key a relayed request must carry. */
export function announceRouter(dataDir: string, port: number): RouterAddress {
  const address = { port, relayKey: randomBytes(24).toString("hex") };
  atomicWriteFileSync(addressFile(dataDir), `${JSON.stringify(address)}\n`);
  try {
    chmodSync(addressFile(dataDir), 0o600);
  } catch {}
  return address;
}

/** Where the router is now; null when it is not running here or has never run. */
export function readRouterAddress(dataDir: string): RouterAddress | null {
  try {
    const raw = JSON.parse(readFileSync(addressFile(dataDir), "utf8")) as Partial<RouterAddress>;
    if (typeof raw.port !== "number" || typeof raw.relayKey !== "string" || !raw.relayKey) {
      return null;
    }
    return { port: raw.port, relayKey: raw.relayKey };
  } catch {
    return null;
  }
}

function hostOf(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

export type HostDecision =
  | { action: "serve" }
  | { action: "redirect"; to: string }
  | { action: "refuse" };

/**
 * What to do with a request, given the public name it came to and whether its
 * path is the kitchen's, the assistant's, or nobody's.
 */
export function hostDecision(args: {
  host: string | null | undefined;
  method: string;
  accept: string | null | undefined;
  surface: "kitchen" | "artifact" | "none";
  pathAndQuery: string;
  kitchenOrigin: string | null | undefined;
  artifactsOrigin: string | null | undefined;
}): HostDecision {
  const kitchen = hostOf(args.kitchenOrigin);
  const artifacts = hostOf(args.artifactsOrigin);
  if (!kitchen || !artifacts || kitchen === artifacts || args.surface === "none") {
    return { action: "serve" };
  }
  const host = (args.host ?? "").toLowerCase();
  const wrongName =
    (host === kitchen && args.surface === "artifact") ||
    (host === artifacts && args.surface === "kitchen");
  if (!wrongName) return { action: "serve" };
  // A person following a link: send them to the name it lives at now.
  const navigating =
    (args.method === "GET" || args.method === "HEAD") && (args.accept ?? "").includes("text/html");
  if (navigating) {
    const origin = (args.surface === "artifact" ? args.artifactsOrigin : args.kitchenOrigin) ?? "";
    return { action: "redirect", to: `${origin.replace(/\/+$/, "")}${args.pathAndQuery}` };
  }
  // A kitchen page was never at the other name, so nothing there depends on it.
  if (args.surface === "kitchen") return { action: "refuse" };
  // A program at the kitchen's name asking for something that used to be
  // there (a webhook, a preview, a page's own images): answered as before.
  return { action: "serve" };
}

/**
 * Hand a request to the router as it arrived, adding the key and the name it
 * came to. The answer is the router's, untouched.
 */
export async function relayToRouter(req: Request, router: RouterAddress): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set(RELAY_HOST_HEADER, req.headers.get("host") ?? url.host);
  headers.set(RELAY_KEY_HEADER, router.relayKey);
  headers.delete("host");
  try {
    const res = await fetch(`http://127.0.0.1:${router.port}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch {
    return new Response("This page is restarting. Try again in a minute.", { status: 502 });
  }
}

/**
 * The public name a request to the router came to: the one the portal's
 * listener vouches for when the key is right, otherwise its own Host header.
 */
export function publicHostOf(
  req: Request,
  relayKey: string | null,
): { host: string | null; relayed: boolean } {
  const key = req.headers.get(RELAY_KEY_HEADER);
  if (relayKey && key && key === relayKey) {
    return { host: req.headers.get(RELAY_HOST_HEADER), relayed: true };
  }
  return { host: req.headers.get("host"), relayed: false };
}
