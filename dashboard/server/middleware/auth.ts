import type { MiddlewareHandler } from "hono";
import { COOKIE_NAME, readCookie, verifySession } from "../auth.ts";

type Deps = { secret: Buffer };

export function authMiddleware(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    const raw = readCookie(c.req.header("cookie") ?? null);
    if (!raw) return c.json({ error: "unauthenticated" }, 401);
    const payload = verifySession(raw, deps.secret);
    if (!payload) {
      c.header("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0`);
      return c.json({ error: "unauthenticated" }, 401);
    }
    c.set("user", payload.sub);
    await next();
  };
}
