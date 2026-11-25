/**
 * Reading what the system says is exposed: the listeners another machine can
 * connect to, and the tunnels that publish a local port to the internet.
 *
 * These are the parsers only, kept low in the layering because two things
 * above need them: the record of what is exposed (boot/exposure.ts) and the
 * watch, which closes a tunnel nobody registered and takes the quick ones
 * down in a lockdown.
 */
import { basename } from "node:path";

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
