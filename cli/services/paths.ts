/** Resolved paths used across CLI commands. */

import { resolve } from "node:path";

export const REPO = process.env.EDMUND_REPO ?? resolve(import.meta.dir, "../..");
export const SERVICE_SH = resolve(REPO, "scripts/launchd/service.sh");
export const DAEMON_LOG = resolve(REPO, "data/daemon.log");
export const DASHBOARD_LOG = resolve(REPO, "data/dashboard.log");
export const TRADING_LOG = resolve(REPO, "data/trading.launchd.out.log");
export const FISHING_LOG = resolve(REPO, "data/fishing.launchd.out.log");

export const HARNESS_LABEL = "com.edmund-harness";
export const DASHBOARD_LABEL = "com.edmund-harness.dashboard";
export const TRADING_LABEL = "com.edmund-harness.trading";
export const FISHING_LABEL = "com.edmund-harness.fishing";
