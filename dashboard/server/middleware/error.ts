import { randomBytes } from "node:crypto";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Clients get a correlation id, the log gets the detail. An exception
 * message can carry file paths, SQL, or a fragment of a secret; none of that
 * belongs in a response body, even to an authenticated operator, because the
 * same handler serves the token-gated public routes.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "http error" }, err.status);
  }
  const id = randomBytes(4).toString("hex");
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[dashboard] unhandled id=${id} ${c.req.method} ${c.req.path}`, detail);
  return c.json({ error: "internal error", id }, 500);
};
