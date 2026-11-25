/**
 * What on this machine can be reached from outside it, kept on record.
 *
 * The access log covers the servers the harness runs. It cannot cover a
 * program the assistant started with a tunnel of its own, or anything that
 * listens on the network directly, and those are the ones nobody remembers:
 * on 2026-11-25 this machine had five tunnels up and one of them led to a
 * port no harness server owned.
 *
 * Every five minutes this lists two things as the system reports them. The
 * tunnels: each `cloudflared` and the local address it publishes, when its
 * command line says. And the listeners: every TCP port this account's
 * processes have open that is not bound to loopback, which is what another
 * machine on the network can connect to. The first reading of each day goes
 * to the `security` channel whole; after that, only what opened (a warning)
 * and what closed.
 */
import { basename } from "node:path";
import { log } from "../util/log.ts";
import { quietRead } from "./telemetry.ts";

export type Listener = { command: string; pid: number; address: string; port: number };
export type Tunnel = { pid: number; kind: "quick" | "named"; target: string };

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: listeners another machine can reach, one per port and process. */
export function parseListeners(output: string): Listener[] {
  const found = new Map<string, Listener>();
  let pid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) {
      const m = /^n(.*):(\d+)$/.exec(line);
      if (!m) continue;
      const address = m[1]!;
      // Bound to this machine only: nothing outside it can connect.
      if (address.startsWith("127.") || address === "[::1]" || address === "localhost") continue;
      const port = Number(m[2]);
      found.set(`${command}|${port}`, { command, pid, address, port });
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port);
}

/** `ps -axo pid=,command=`: each tunnel process and what it publishes. A token is never read. */
export function parseTunnels(output: string): Tunnel[] {
  const tunnels: Tunnel[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const argv = m[2]!.split(/\s+/);
    if (basename(argv[0] ?? "") !== "cloudflared" || !argv.includes("tunnel")) continue;
    const url = argv[argv.indexOf("--url") + 1];
    if (argv.includes("--url") && url) {
      tunnels.push({ pid: Number(m[1]), kind: "quick", target: url });
      continue;
    }
    // A named tunnel's routes are set at the provider; the token file's name says which one it is.
    const tokenFile = argv[argv.indexOf("--token-file") + 1];
    tunnels.push({
      pid: Number(m[1]),
      kind: "named",
      target: argv.includes("--token-file") && tokenFile ? basename(tokenFile) : "named tunnel",
    });
  }
  return tunnels;
}

const listenerKey = (l: Listener) => `${l.command}:${l.port}`;
const tunnelKey = (t: Tunnel) => `${t.kind}:${t.target}`;

export type ExposureOptions = {
  intervalMs: number;
  readListeners?: () => Promise<Listener[]>;
  readTunnels?: () => Promise<Tunnel[]>;
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
      if (day !== this.reportedDay) {
        this.reportedDay = day;
        log.event(
          "security",
          "exposure",
          `reachable from outside: ${tunnels.length} tunnels, ${listeners.length} network listeners`,
          { kind: "inventory", tunnels, listeners },
        );
      } else {
        for (const [key, t] of nowTunnels) {
          if (this.tunnels.has(key)) continue;
          log.event(
            "security",
            "exposure",
            `tunnel opened: ${t.kind} to ${t.target}`,
            { kind: "opened", tunnel: t },
            "warn",
          );
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
