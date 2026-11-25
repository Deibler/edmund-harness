/**
 * Decides which services a command targets based on --harness / --dashboard /
 * --fishing flags. No flag = all of them. Shared across
 * start/stop/restart/status/kill.
 */

import type { Parsed } from "../args.ts";
import { hasFlag } from "../args.ts";
import type { Svc } from "./launchctl.ts";

export function resolveTargets(p: Parsed): Svc[] {
  const h = hasFlag(p, "harness");
  const d = hasFlag(p, "dashboard");
  const f = hasFlag(p, "fishing");
  // No flag = all managed services: harness daemon + web dashboard +
  // fishing data API.
  if (!h && !d && !f) return ["harness", "dashboard", "fishing"];
  const out: Svc[] = [];
  if (h) out.push("harness");
  if (d) out.push("dashboard");
  if (f) out.push("fishing");
  return out;
}

export function prettyName(svc: Svc): string {
  if (svc === "harness") return "iMessage daemon";
  if (svc === "fishing") return "fishing data API";
  return "dashboard";
}

const TARGET_FLAGS = ["harness", "dashboard", "fishing"];

/** The commands that start and stop services, and the flags each takes besides the targets. */
const SERVICE_COMMANDS: Record<string, { does: string; flags: string[] }> = {
  start: { does: "start them under launchd (--local: in the foreground)", flags: ["local"] },
  stop: { does: "stop them", flags: [] },
  restart: { does: "bounce them", flags: [] },
  status: { does: "show launchd and local state", flags: [] },
  kill: { does: "uninstall the launchd jobs and kill local strays", flags: [] },
};

/**
 * Why a service command must not run as typed, or null when it may.
 *
 * These commands stop and start the assistant, and they ignored what they
 * did not understand. `edmund restart --help` restarted every service, with
 * a conversation in flight (2026-11-25), and `edmund restart harness` did
 * too: without its dashes "only the daemon" meant "all of them". A request
 * for help gets the usage, and anything the command does not take is
 * refused before it acts.
 */
export function serviceCommandRefusal(
  cmd: string,
  p: Parsed,
): { help: boolean; text: string } | null {
  const spec = SERVICE_COMMANDS[cmd];
  if (!spec) return null;
  const takes = [...TARGET_FLAGS, ...spec.flags];
  const usage = [
    `usage: edmund ${cmd} ${takes.map((f) => `[--${f}]`).join(" ")}`,
    `  ${spec.does}: the services named, or all of them when none is named.`,
  ].join("\n");
  if ("help" in p.flags || "h" in p.flags) return { help: true, text: usage };
  const dashed = (f: string) => (f.length === 1 ? `-${f}` : `--${f}`);
  const unknown = Object.keys(p.flags).filter((f) => !takes.includes(f));
  // `--harness dashboard` reads as a flag with a value: the word is a stray too.
  const words = [
    ...p.positional,
    ...takes.map((f) => p.flags[f]).filter((v): v is string => typeof v === "string"),
  ];
  if (unknown.length === 0 && words.length === 0) return null;
  const what = [
    ...(unknown.length > 0 ? [`no flag ${unknown.map(dashed).join(", ")}`] : []),
    ...(words.length > 0 ? [`no use for "${words.join(" ")}" (a service is named --harness)`] : []),
  ].join(" and ");
  return { help: false, text: `edmund ${cmd} has ${what}, so nothing was done.\n${usage}` };
}
