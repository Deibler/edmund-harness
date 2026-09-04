import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return hostHeader.replace(/:\d+$/, "");
  }
}

/**
 * Cross-site request forgery guard for state-changing API calls.
 *
 * The dashboard is a same-origin SPA, so a mutating request from a browser
 * either carries an Origin equal to our own host or is not ours. Requests
 * without an Origin (curl, the CLI, older clients) pass unless the browser
 * itself says the request is cross-site via Sec-Fetch-Site. SameSite=Strict
 * on the cookie already blocks most of this; the header check is the second
 * lock for browsers that do not honour it.
 */
export function originGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        return c.json({ error: "bad origin" }, 403);
      }
      // Host names only, ports ignored: the Vite dev proxy forwards the
      // browser's Origin (port 5173) to a server that sees Host as 4747, and
      // a second port on the same machine is not the boundary this guards.
      const hosts = new Set<string>();
      const host = c.req.header("host");
      if (host) hosts.add(hostnameOf(host));
      const fwd = c.req.header("x-forwarded-host");
      if (fwd) for (const h of fwd.split(",")) hosts.add(hostnameOf(h.trim()));
      if (!hosts.has(originHost)) return c.json({ error: "cross-origin request refused" }, 403);
    } else if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "cross-site request refused" }, 403);
    }
    return next();
  };
}

/** Headers every response should carry, on both listeners. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
  };
}
