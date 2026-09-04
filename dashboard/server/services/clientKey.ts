import type { Context } from "hono";

/**
 * A stable key for the remote client, for throttles. Behind the tunnel the
 * only truthful address is the first X-Forwarded-For entry; direct on the
 * LAN it is the socket address Bun reports. Falls back to a shared bucket
 * rather than skipping the throttle.
 */
export function clientKey(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  try {
    const server = (
      c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined
    )?.requestIP;
    const addr = server?.(c.req.raw)?.address;
    if (addr) return addr;
  } catch {}
  return "unknown";
}
