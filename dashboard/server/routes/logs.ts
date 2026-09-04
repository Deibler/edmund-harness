import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { LogTail } from "../services/logTail.ts";

type Deps = { tail: LogTail };

export function logsRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const limit = Math.min(2000, Number.parseInt(c.req.query("limit") ?? "500", 10));
    return c.json({ lines: deps.tail.snapshot(limit) });
  });

  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      const initial = deps.tail.snapshot(500);
      for (const line of initial) {
        await stream.writeSSE({ event: "line", data: JSON.stringify(line) });
      }
      const unsub = deps.tail.subscribe({
        onLine: (line) => {
          stream.writeSSE({ event: "line", data: JSON.stringify(line) }).catch(() => {});
        },
        onClose: () => {
          stream.close().catch(() => {});
        },
      });
      // Heartbeat so proxies don't idle-kill the connection.
      const hb = setInterval(() => {
        stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
      }, 15_000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(hb);
      unsub();
    }),
  );

  return app;
}
