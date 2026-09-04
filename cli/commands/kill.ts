/**
 * `edmund kill [--harness] [--dashboard]`
 *
 * Persistent shutdown: uninstall launchd job so KeepAlive stops respawning,
 * kill any local instances. Reverses `edmund start` entirely.
 */

import type { Parsed } from "../args.ts";
import * as ctl from "../services/launchctl.ts";
import { prettyName, resolveTargets } from "../services/target.ts";
import { fail, info, ok, section } from "../ui.ts";

export async function killCommand(p: Parsed): Promise<void> {
  for (const svc of resolveTargets(p)) {
    section(`kill ${prettyName(svc)}`);
    const st = ctl.svcState(svc);
    if (st.loaded) {
      const r = ctl.uninstall(svc);
      if (r.ok) ok("launchd job uninstalled.");
      else fail(r.out || "uninstall failed");
    } else {
      info("launchd job not loaded.");
    }
    const strays = ctl.localPids(svc).filter((pid) => pid !== process.pid);
    if (strays.length > 0) {
      ctl.killLocalPids(svc);
      ok(`killed ${strays.length} local instance(s).`);
    } else {
      info("no local instances.");
    }
  }
}
