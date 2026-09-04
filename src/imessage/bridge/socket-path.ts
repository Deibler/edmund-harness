import { isAbsolute, resolve } from "node:path";

import { CONTROL_SOCKET_ENV } from "./protocol.ts";

/**
 * Where the daemon's control socket lives.
 *
 * The daemon resolves it from `paths.data_dir` and exports it, because
 * `data_dir` defaults to a relative path and a `claude -p` subprocess runs with
 * its sandbox as the working directory — resolving it independently on both
 * sides would put the two in different places on exactly the machines where the
 * default was left alone.
 *
 * An absolute path in the environment therefore wins, and is what subprocesses
 * normally use.
 */
export function controlSocketPath(dataDir?: string): string {
  const fromEnv = process.env[CONTROL_SOCKET_ENV];
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv;
  if (!dataDir) {
    throw new Error(
      `no ${CONTROL_SOCKET_ENV} in the environment and no data_dir given, so the Messages control socket cannot be located`,
    );
  }
  return resolve(dataDir, "bridge-control.sock");
}

/** Publishes the resolved path so spawned subprocesses inherit it. */
export function publishControlSocketPath(socketPath: string): void {
  process.env[CONTROL_SOCKET_ENV] = socketPath;
}
