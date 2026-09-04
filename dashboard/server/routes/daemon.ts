import { Hono } from "hono";
import { control, setDebug, status } from "../services/daemonCtl.ts";

export function daemonRoutes(): Hono {
  const app = new Hono();

  app.get("/status", async (c) => c.json({ status: await status() }));

  app.post("/:cmd", async (c) => {
    const cmd = c.req.param("cmd");
    if (cmd !== "start" && cmd !== "stop" && cmd !== "restart") {
      return c.json({ error: `unknown cmd: ${cmd}` }, 400);
    }
    const res = await control(cmd);
    return c.json(res, res.ok ? 200 : 500);
  });

  app.post("/debug/:state", async (c) => {
    const state = c.req.param("state");
    if (state !== "on" && state !== "off" && state !== "show") {
      return c.json({ error: `unknown debug state: ${state}` }, 400);
    }
    const res = await setDebug(state);
    return c.json(res, res.ok ? 200 : 500);
  });

  return app;
}
