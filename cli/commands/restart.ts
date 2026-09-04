/**
 * `edmund restart [--harness] [--dashboard]`
 *
 * Launchctl kickstart -k. Works whether the job is currently running or not
 * as long as it's loaded — if it's not loaded, we install + kickstart.
 */

import type { Parsed } from "../args.ts";
import * as ctl from "../services/launchctl.ts";
import { preflight } from "../services/preflight.ts";
import { ensureRadarOmegaForService } from "../services/radaromega.ts";
import { prettyName, resolveTargets } from "../services/target.ts";
import { fail, info, ok, section } from "../ui.ts";

export async function restartCommand(p: Parsed): Promise<void> {
  for (const svc of resolveTargets(p)) {
    section(`restart ${prettyName(svc)}`);
    const st = ctl.svcState(svc);
    if (!st.loaded) {
      info("not loaded — installing launchd job.");
      await ensureRadarOmegaForService(svc);
      await preflight(svc);
      const r = ctl.install(svc);
      if (!r.ok) {
        fail(r.out || "install failed");
        continue;
      }
      ok("installed + started.");
      continue;
    }
    await ensureRadarOmegaForService(svc);
    const r = ctl.restart(svc);
    if (r.ok) ok("restarted.");
    else fail(r.out || "launchctl kickstart failed");
    // Give kickstart a beat to settle, then sweep the port in case a
    // pre-kickstart instance didn't exit cleanly and is still squatting.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await preflight(svc);
  }
}
