import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  buildCookie,
  clearCookie,
  readCookie,
  requestIsSecure,
  signSession,
  verifyPin,
  verifySession,
} from "../auth.ts";
import { getConfig } from "../config.ts";
import { clientKey } from "../services/clientKey.ts";
import { LoginThrottle } from "../services/loginThrottle.ts";
import type { AuthStatus } from "../types.ts";

export function authRoutes(secret: Buffer, throttle: LoginThrottle = new LoginThrottle()): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const config = getConfig();
    const raw = readCookie(c.req.header("cookie") ?? null);
    const payload = raw ? verifySession(raw, secret) : null;
    const body: AuthStatus = {
      authenticated: Boolean(payload),
      pinConfigured: Boolean(config.dashboard.pin_hash),
    };
    return c.json(body);
  });

  // A PIN is a few bytes. Anything larger is not a login.
  app.use("/login", bodyLimit({ maxSize: 4 * 1024 }));

  app.post("/login", async (c) => {
    const key = clientKey(c);
    const gate = throttle.check(key);
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSec));
      return c.json({ error: "too many attempts" }, 429);
    }
    const config = getConfig(true);
    if (!config.dashboard.pin_hash) {
      return c.json({ error: "PIN not configured. Run `bun run dashboard:set-pin <pin>`." }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { pin?: string };
    if (!body?.pin || typeof body.pin !== "string") {
      return c.json({ error: "pin required" }, 400);
    }
    const ok = await verifyPin(body.pin, config.dashboard.pin_hash);
    if (!ok) {
      const after = throttle.recordFailure(key);
      if (!after.allowed) c.header("Retry-After", String(after.retryAfterSec));
      return c.json({ error: "incorrect pin" }, after.allowed ? 401 : 429);
    }
    throttle.recordSuccess(key);
    const exp = Date.now() + config.dashboard.session_days * 86_400_000;
    const token = signSession({ v: 1, sub: "user", exp }, secret);
    c.header(
      "Set-Cookie",
      buildCookie(token, config.dashboard.session_days, requestIsSecure(c.req)),
    );
    return c.json({ ok: true });
  });

  app.post("/logout", (c) => {
    c.header("Set-Cookie", clearCookie(requestIsSecure(c.req)));
    return c.json({ ok: true });
  });

  return app;
}
