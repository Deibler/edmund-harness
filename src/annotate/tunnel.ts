import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cloudflare quick-tunnel manager for annotation links.
 *
 * Why this exists:
 *   The annotation URL has to work on the user's phone. LAN IPs only work
 *   on the same Wi-Fi as the host Mac, which is a poor UX for "text me
 *   markup on this logo." A Cloudflare quick tunnel
 *   (https://*.trycloudflare.com) gets us a public HTTPS URL for localhost
 *   with no DNS/TLS setup on the operator's side.
 *
 * Lifecycle:
 *   1. MCP tool calls startQuickTunnel(port, ttlSec).
 *   2. We spawn scripts/cloudflared-quick-tunnel.sh detached. It runs
 *      cloudflared, captures the public URL to a file, then sleeps TTL and
 *      kills cloudflared on exit (trap).
 *   3. We poll the URL file for up to ~20s and return {url, managerPid}.
 *   4. If the annotation is submitted early, the dashboard route calls
 *      killTunnel(managerPid) to drop the tunnel immediately. Otherwise the
 *      script self-terminates when TTL elapses.
 *
 * Failure modes all bubble up as thrown Error — callers fall back to the
 * LAN URL with a warning.
 */

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cloudflared-quick-tunnel.sh",
);

export type QuickTunnel = {
  url: string;
  /** PID of the wrapper script; SIGTERM it to kill early. */
  managerPid: number;
  /** Internal — caller should not touch. Used by close() for cleanup. */
  workDir: string;
};

export async function startQuickTunnel(port: number, ttlSec: number): Promise<QuickTunnel> {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(`tunnel wrapper script missing: ${SCRIPT_PATH}`);
  }

  const workDir = mkdtempSync(join(tmpdir(), "edmund-tunnel-"));
  const urlFile = join(workDir, "url");

  const child = spawn("bash", [SCRIPT_PATH, String(port), String(ttlSec), urlFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Errors bubble through the event loop; if the script can't start
  // (missing bash, bad perms), we'd see ENOENT. Catch here so callers
  // get a clean throw rather than an unhandled event.
  child.on("error", () => {
    // swallow; the polling loop below will time out and report a better message
  });
  child.unref();
  const managerPid = child.pid;
  if (!managerPid) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error("tunnel wrapper failed to spawn");
  }

  // Poll for the URL file. Cloudflared usually prints the URL in 2-4s;
  // we give it 20s total before giving up.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(urlFile)) {
      const raw = readFileSync(urlFile, "utf8").trim();
      if (raw.startsWith("https://") && raw.includes(".trycloudflare.com")) {
        return { url: raw, managerPid, workDir };
      }
    }
    // If the wrapper already exited, the tunnel failed to come up — stop
    // polling. We use `kill(pid, 0)` as a liveness check: it throws ESRCH
    // when the process is gone, no-ops when it's still around.
    try {
      process.kill(managerPid, 0);
    } catch {
      rmSync(workDir, { recursive: true, force: true });
      throw new Error(
        "cloudflared exited before publishing a URL — check that `cloudflared` is on PATH and the port is reachable",
      );
    }
    await sleep(250);
  }
  // Timeout — kill the wrapper before giving up.
  killTunnel(managerPid);
  rmSync(workDir, { recursive: true, force: true });
  throw new Error("cloudflared quick tunnel did not publish a URL within 20s");
}

/**
 * End a tunnel early. Safe to call after it's already exited (no-op on
 * ESRCH). The wrapper's SIGTERM trap kills cloudflared and cleans up its
 * temp files.
 */
export function killTunnel(managerPid: number): void {
  try {
    process.kill(managerPid, "SIGTERM");
  } catch {
    // already gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
