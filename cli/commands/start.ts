/**
 * `edmund start [--harness] [--dashboard] [--local]`
 *
 * Default behavior (no --local): install the launchd job if missing, kickstart
 * it, refuse if it's already running globally. With --local: uninstall the
 * launchd job, then foreground the process so the user can see stdout.
 */

import { spawn } from "node:child_process";
import type { Parsed } from "../args.ts";
import { hasFlag } from "../args.ts";
import * as ctl from "../services/launchctl.ts";
import type { Svc } from "../services/launchctl.ts";
import { REPO } from "../services/paths.ts";
import { preflight } from "../services/preflight.ts";
import { ensureRadarOmegaForService } from "../services/radaromega.ts";
import { prettyName, resolveTargets } from "../services/target.ts";
import { color, fail, hr, info, ok, print, section, warn } from "../ui.ts";

export async function startCommand(p: Parsed): Promise<void> {
  const targets = resolveTargets(p);
  const local = hasFlag(p, "local");
  if (local && targets.length > 1) {
    fail("--local requires --harness or --dashboard (one at a time)");
    process.exit(2);
  }
  for (const svc of targets) {
    section(
      `start ${prettyName(svc)} ${local ? color.yellow("[local]") : color.dim("[global/launchd]")}`,
    );
    if (local) await startLocal(svc);
    else await startGlobal(svc);
  }
}

async function startGlobal(svc: Svc): Promise<void> {
  const st = ctl.svcState(svc);
  if (st.running) {
    warn(`${prettyName(svc)} is already running globally (pid ${st.pid}).`);
    info(`use  ${color.cyan(`edmund restart --${svc}`)}  to bounce it.`);
    return;
  }
  if (st.loaded) {
    info("launchd job loaded but not running — kickstarting.");
    await ensureRadarOmegaForService(svc);
    await preflight(svc);
    const r = ctl.start(svc);
    if (r.ok) ok("kickstarted.");
    else fail(r.out);
    return;
  }
  const strays = ctl.localPids(svc);
  if (strays.length > 0) {
    warn(`found ${strays.length} local instance(s) — killing before launchd install.`);
    ctl.killLocalPids(svc);
  }
  await ensureRadarOmegaForService(svc);
  await preflight(svc);
  const r = ctl.install(svc);
  if (r.ok) {
    ok(`${prettyName(svc)} installed + started.`);
    hr();
    print(color.dim(r.out));
  } else {
    fail(r.out);
  }
}

async function startLocal(svc: Svc): Promise<void> {
  const st = ctl.svcState(svc);
  if (st.loaded) {
    warn(`uninstalling launchd job for ${prettyName(svc)} first.`);
    const u = ctl.uninstall(svc);
    if (!u.ok) {
      fail(u.out);
      process.exit(1);
    }
  }
  const strays = ctl.localPids(svc).filter((p) => p !== process.pid);
  if (strays.length > 0) {
    warn(`killing ${strays.length} local instance(s).`);
    ctl.killLocalPids(svc);
  }
  await preflight(svc);
  await ensureRadarOmegaForService(svc);
  info("foreground start — Ctrl-C to stop. Launchd will NOT auto-restart.");
  hr();
  // The fishing service is a uv-managed Python server in another repo; run its
  // launchd wrapper directly. The rest are bun entrypoints in this repo.
  // Inherit stdio so the user sees logs live.
  const child =
    svc === "fishing"
      ? spawn("/bin/bash", [`${REPO}/scripts/launchd/run-fishing.sh`], { stdio: "inherit" })
      : spawn(
          "/opt/homebrew/bin/bun",
          [
            "run",
            svc === "harness"
              ? "src/main.ts"
              : svc === "trading"
                ? "integrations/trading/dashboard/main.ts"
                : "dashboard/server/main.ts",
          ],
          { cwd: REPO, stdio: "inherit" },
        );
  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      print("");
      info(`${prettyName(svc)} exited with code ${code}`);
      resolve();
    });
  });
}
