/**
 * `edmund stop [--harness] [--dashboard]`
 *
 * Sends SIGTERM via launchctl. Launchd KeepAlive means the job relaunches
 * after the throttle window — use `edmund kill` to persistently stop.
 */

import type { Parsed } from "../args.ts";
import * as ctl from "../services/launchctl.ts";
import { prettyName, resolveTargets } from "../services/target.ts";
import { fail, info, ok, section } from "../ui.ts";

export async function stopCommand(p: Parsed): Promise<void> {
  for (const svc of resolveTargets(p)) {
    section(`stop ${prettyName(svc)}`);
    const st = ctl.svcState(svc);
    if (!st.loaded) {
      info(`${prettyName(svc)} is not loaded (nothing to stop globally).`);
      const strays = ctl.killLocalPids(svc);
      if (strays > 0) ok(`killed ${strays} local instance(s).`);
      continue;
    }
    const r = ctl.stop(svc);
    if (r.ok) {
      ok(`SIGTERM sent.`);
      info(`launchd will respawn after ~30s unless uninstalled — see  edmund kill`);
    } else {
      fail(r.out || "launchctl stop failed");
    }
  }
}
