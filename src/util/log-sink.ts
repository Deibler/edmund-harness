import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { format } from "node:util";

/**
 * Mirror console output into data/daemon.log so the daemon is observable
 * from any shell (`bun run logs` or `./scripts/logs`). Hooks `console.*`
 * directly — Bun's console bypasses `process.stdout.write`, so
 * stream-level hooks miss it.
 *
 * Installed by main.ts at boot. The MCP subprocess installs it too (via
 * installLogSinkFromEnv) so tool-call logs land in the same file, giving
 * a single audit trail for the whole session.
 */
export function installLogSink(dataDir: string, prefix = "", filename = "daemon.log"): string {
  const path = join(dataDir, filename);
  mkdirSync(dirname(path), { recursive: true });

  const tee =
    (level: string, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original(...args);
      try {
        const line = `${new Date().toISOString()} [${level}] ${prefix}${format(...args)}\n`;
        appendFileSync(path, line);
      } catch {}
    };

  console.log = tee("log", console.log.bind(console));
  console.info = tee("info", console.info.bind(console));
  console.warn = tee("warn", console.warn.bind(console));
  console.error = tee("error", console.error.bind(console));
  return path;
}

/**
 * Install the log sink using EDMUND_DATA_DIR from the environment. Used
 * by subprocesses (MCP server, agent-runner) that inherit env from the
 * parent daemon. Silent no-op if the env var isn't set — safe to call
 * unconditionally at entry.
 *
 * The prefix tags lines so you can tell which subprocess wrote them in
 * the shared file (e.g. `mcp[+17175551212] ` or `agent[abc123] `).
 */
export function installLogSinkFromEnv(prefix = ""): string | null {
  const dataDir = process.env.EDMUND_DATA_DIR;
  if (!dataDir) return null;
  return installLogSink(resolve(dataDir), prefix);
}
