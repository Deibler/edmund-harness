/** Resolved paths used across CLI commands. */

import { resolve } from "node:path";

export const REPO = process.env.EDMUND_REPO ?? resolve(import.meta.dir, "../..");
export const SERVICE_SH = resolve(REPO, "scripts/launchd/service.sh");
export const LOGS_DIR = process.env.EDMUND_LOGS_DIR ?? resolve(REPO, "logs");
export const DAEMON_LOG = resolve(LOGS_DIR, "daemon.log");
export const DASHBOARD_LOG = resolve(LOGS_DIR, "dashboard.log");
export const FISHING_LOG = resolve(LOGS_DIR, "services/fishing.launchd.out.log");

export const HARNESS_LABEL = "com.edmund-harness";
export const DASHBOARD_LABEL = "com.edmund-harness.dashboard";
export const FISHING_LABEL = "com.edmund-harness.fishing";
