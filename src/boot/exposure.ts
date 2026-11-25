/**
 * What on this machine can be reached from outside it, kept on record.
 *
 * The access log covers the servers the harness runs. It cannot cover a
 * program the assistant started with a tunnel of its own, or anything that
 * listens on the network directly, and those are the ones nobody remembers:
 * on 2026-11-25 this machine had five tunnels up and one of them led to a
 * port no harness server owned.
 *
 * Every half minute this lists two things as the system reports them. The
 * tunnels: each `cloudflared` and the local address it publishes, when its
 * command line says. And the listeners: every TCP port this account's
 * processes have open that is not bound to loopback, which is what another
 * machine on the network can connect to. The first reading of each day goes
 * to the `security` channel whole; after that, only what opened (a warning)
 * and what closed.
 */
import {
  type Listener,
  type Tunnel,
  parseListeners,
  parseTunnels,
} from "../security/watch/exposure.ts";
import { log } from "../util/log.ts";
import { quietRead } from "./telemetry.ts";

export { type Listener, type Tunnel, parseListeners, parseTunnels };

const listenerKey = (l: Listener) => `${l.command}:${l.port}`;
const tunnelKey = (t: Tunnel) => `${t.kind}:${t.target}`;

export type ExposureOptions = {
  intervalMs: number;
  readListeners?: () => Promise<Listener[]>;
  readTunnels?: () => Promise<Tunnel[]>;
  /** Told of each tunnel or listener that was not there at the last reading. */
  onOpened?: (opened: { tunnel?: Tunnel; listener?: Listener }) => void;
};

export class ExposureWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Map<string, Listener>();
  private tunnels = new Map<string, Tunnel>();
  private reportedDay = "";

  constructor(private readonly opts: ExposureOptions) {}

  start(): void {
    if (this.timer || this.opts.intervalMs <= 0) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(now: number = Date.now()): Promise<void> {
    try {
      const [listeners, tunnels] = await Promise.all([
        this.opts.readListeners?.() ??
          quietRead(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]).then(
            parseListeners,
          ),
        this.opts.readTunnels?.() ??
          quietRead(["/bin/ps", "-axo", "pid=,command="]).then(parseTunnels),
      ]);
      const day = new Date(now).toISOString().slice(0, 10);
      const nowListeners = new Map(listeners.map((l) => [listenerKey(l), l]));
      const nowTunnels = new Map(tunnels.map((t) => [tunnelKey(t), t]));
      // The first reading is the baseline: nothing in it "opened".
      const first = this.reportedDay === "";
      if (day !== this.reportedDay) {
        this.reportedDay = day;
        log.event(
          "security",
          "exposure",
          `reachable from outside: ${tunnels.length} tunnels, ${listeners.length} network listeners`,
          { kind: "inventory", tunnels, listeners },
        );
      }
      if (!first) {
        for (const [key, t] of nowTunnels) {
          if (this.tunnels.has(key)) continue;
          log.event(
            "security",
            "exposure",
            `tunnel opened: ${t.kind} to ${t.target}`,
            { kind: "opened", tunnel: t },
            "warn",
          );
          this.opts.onOpened?.({ tunnel: t });
        }
        for (const [key, t] of this.tunnels) {
          if (nowTunnels.has(key)) continue;
          log.event("security", "exposure", `tunnel closed: ${t.kind} to ${t.target}`, {
            kind: "closed",
            tunnel: t,
          });
        }
        for (const [key, l] of nowListeners) {
          if (this.listeners.has(key)) continue;
          log.event(
            "security",
            "exposure",
            `network listener opened: ${l.command} on port ${l.port}`,
            { kind: "opened", listener: l },
            "warn",
          );
          this.opts.onOpened?.({ listener: l });
        }
        for (const [key, l] of this.listeners) {
          if (nowListeners.has(key)) continue;
          log.event(
            "security",
            "exposure",
            `network listener closed: ${l.command} on port ${l.port}`,
            { kind: "closed", listener: l },
          );
        }
      }
      this.listeners = nowListeners;
      this.tunnels = nowTunnels;
    } catch (err) {
      log.event(
        "security",
        "exposure",
        "could not read what is exposed",
        { err: (err as Error).message },
        "warn",
      );
    }
  }
}
