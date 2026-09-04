/**
 * Decides which services a command targets based on --harness / --dashboard /
 * --trading / --fishing flags. No flag = all of them. Shared across
 * start/stop/restart/status/kill.
 */

import type { Parsed } from "../args.ts";
import { hasFlag } from "../args.ts";
import type { Svc } from "./launchctl.ts";

export function resolveTargets(p: Parsed): Svc[] {
  const h = hasFlag(p, "harness");
  const d = hasFlag(p, "dashboard");
  const t = hasFlag(p, "trading");
  const f = hasFlag(p, "fishing");
  // No flag = all managed services: harness daemon + web dashboard + trading
  // dashboard + fishing data API.
  if (!h && !d && !t && !f) return ["harness", "dashboard", "trading", "fishing"];
  const out: Svc[] = [];
  if (h) out.push("harness");
  if (d) out.push("dashboard");
  if (t) out.push("trading");
  if (f) out.push("fishing");
  return out;
}

export function prettyName(svc: Svc): string {
  if (svc === "harness") return "iMessage daemon";
  if (svc === "trading") return "trading dashboard";
  if (svc === "fishing") return "fishing data API";
  return "dashboard";
}
