import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import { printerConfig } from "../config.ts";
import { grabFrame } from "./camera.ts";
import { openLink } from "./link.ts";
import type { PrinterState } from "./report.ts";
import { type RuntimeInfo, framesDir, readRuntimeInfo } from "./settings.ts";

/**
 * How a session's tools reach the printer: through the daemon's printer
 * runtime when it is up, which holds the one live connection and is the only
 * thing allowed to start, cancel or resume a print. When the daemon is not
 * reachable, reading the printer still works over a short direct connection;
 * moving it does not.
 */

export type Snapshot = {
  state: PrinterState;
  connected: boolean;
  lastError: string;
  updatedMs: number;
  printKey: string;
  modules: Array<Record<string, unknown>>;
  via: "daemon" | "direct";
};

export class PrinterAccess {
  private info: RuntimeInfo | null;

  constructor(
    private readonly config: Config,
    private readonly dataDir: string,
  ) {
    this.info = readRuntimeInfo(dataDir);
  }

  private async api(path: string, body?: unknown, timeoutMs = 30_000): Promise<Response> {
    if (!this.info) throw new Error("daemon printer runtime not running");
    return fetch(`http://127.0.0.1:${this.info.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.info.secret}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  get daemonUp(): boolean {
    return this.info !== null;
  }

  async snapshot(): Promise<Snapshot> {
    if (this.info) {
      try {
        const r = await this.api("/api/state", undefined, 10_000);
        if (r.ok) {
          const j = (await r.json()) as Omit<Snapshot, "via">;
          if (j.state) return { ...j, via: "daemon" };
        }
      } catch {
        this.info = null;
      }
    }
    const cfg = printerConfig(this.config);
    const link = await openLink({
      host: cfg.host,
      accessCode: cfg.access_code,
      serial: cfg.serial,
    });
    try {
      return {
        state: link.state!,
        connected: true,
        lastError: "",
        updatedMs: link.updatedMs,
        printKey: "",
        modules: link.modules,
        via: "direct",
      };
    } finally {
      link.close();
    }
  }

  /** A camera frame with the chamber light on, saved where print_start can find it by id. */
  async frame(): Promise<{ id: number; path: string; jpeg: Buffer }> {
    if (this.info) {
      const r = await this.api("/api/frame", undefined, 40_000);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `camera unavailable (${r.status})`);
      }
      const jpeg = Buffer.from(await r.arrayBuffer());
      return {
        id: Number(r.headers.get("X-Frame-Id")),
        path: r.headers.get("X-Frame-Path") ?? "",
        jpeg,
      };
    }
    const cfg = printerConfig(this.config);
    const jpeg = await grabFrame(cfg.host, cfg.access_code);
    const id = Date.now();
    const dir = framesDir(this.dataDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jpg`);
    writeFileSync(path, jpeg);
    return { id, path, jpeg };
  }

  async light(on: boolean): Promise<void> {
    if (this.info) {
      const r = await this.api("/api/light", { on });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!j.ok) throw new Error(j.error ?? "light command failed");
      return;
    }
    const cfg = printerConfig(this.config);
    const link = await openLink({
      host: cfg.host,
      accessCode: cfg.access_code,
      serial: cfg.serial,
    });
    try {
      await link.command("system", {
        command: "ledctrl",
        led_node: "chamber_light",
        led_mode: on ? "on" : "off",
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 1,
        interval_time: 1000,
      });
    } finally {
      link.close();
    }
  }

  private requireDaemon(what: string) {
    if (!this.info) {
      throw new Error(
        `${what} goes only through Edmund's daemon, and its printer runtime is not running. It starts with the daemon (edmund restart).`,
      );
    }
  }

  async start(
    jobId: number,
    session: string,
    frameId: number | null,
  ): Promise<{ ok: true; page: string; message: string } | { ok: false; problems: string[] }> {
    this.requireDaemon("Starting a print");
    const r = await this.api("/api/start", { jobId, session, frameId }, 420_000);
    return (await r.json()) as
      | { ok: true; page: string; message: string }
      | { ok: false; problems: string[] };
  }

  async control(
    action: "cancel" | "resume",
    session: string,
    jobId: number | null,
  ): Promise<{ ok: boolean; message: string; problems?: string[] }> {
    this.requireDaemon(action === "cancel" ? "Cancelling a print" : "Resuming a print");
    const r = await this.api("/api/control", { action, session, jobId }, 120_000);
    return (await r.json()) as { ok: boolean; message: string; problems?: string[] };
  }

  /** Ask the runtime to read chat.db for answers now rather than on its next tick. */
  async checkApprovals(): Promise<void> {
    if (!this.info) return;
    await this.api("/api/check-approvals", {}).catch(() => {});
  }
}
