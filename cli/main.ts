#!/usr/bin/env bun
/**
 * edmund — one-stop control for the iMessage harness + dashboard.
 *
 * Top-level commands dispatch into cli/commands/*. Each command owns its
 * own help text so `edmund <cmd> --help` is always the source of truth.
 */

import { parse } from "./args.ts";
import { REPO } from "./services/paths.ts";
// The harness treats paths in config.toml ("./config.toml", "./data", etc.)
// as relative to CWD. Pin CWD to the repo root so the CLI works from
// anywhere on disk.
try {
  process.chdir(REPO);
} catch {}
import { agentsCommand } from "./commands/agents.ts";
import { announceCommand } from "./commands/announce.ts";
import { configCommand } from "./commands/config.ts";
import { creditsCommand } from "./commands/credits.ts";
import { cronCommand } from "./commands/cron.ts";
import { dashboardCommand } from "./commands/dashboard.ts";
import { dataCommand } from "./commands/data.ts";
import { installCommand } from "./commands/install.ts";
import { killCommand } from "./commands/kill.ts";
import { logsCommand } from "./commands/logs.ts";
import { portalCommand } from "./commands/portal.ts";
import { restartCommand } from "./commands/restart.ts";
import { reviewCommand } from "./commands/review.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { skillsCommand } from "./commands/skills.ts";
import { startCommand } from "./commands/start.ts";
import { statusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { serviceCommandRefusal } from "./services/target.ts";
import { color, fail, print } from "./ui.ts";

const HELP = `${color.bold("edmund")} — iMessage harness + dashboard controller

${color.bold("Usage:")}  edmund <command> [flags]

${color.bold("Services")}
  ${color.cyan("start")}        start harness and/or dashboard (launchd by default)
  ${color.cyan("stop")}         stop them (launchd keep-alive will relaunch)
  ${color.cyan("restart")}      bounce them
  ${color.cyan("status")}       show launchd + local state for both services
  ${color.cyan("kill")}         uninstall both launchd jobs and kill local strays

${color.bold("Observe")}
  ${color.cyan("logs")}         what the model is doing, for whom (--follow, --session NAME, --all, --error/--warn, --grep RE, -n N)
               logs channels | logs <channel> [--since 2h] [-f] | logs errors | logs traffic [--since 24h] | logs trace <turn|name> [--at 14:05] | logs tidy
  ${color.cyan("data")}         what is in the data folder and who owns it: data audit | data clean [--apply]
  ${color.cyan("dashboard")}    dashboard URL, --pin, --logs [--follow]
  ${color.cyan("cron")}         list / delete scheduled jobs
  ${color.cyan("sessions")}     list / reset / heal / invoke / rerun / compact / wipe / brownnose
  ${color.cyan("agents")}       list sub-agents (--status)
  ${color.cyan("skills")}       list / search / install / approve marketplace skills
  ${color.cyan("announce")}     feature log — tell regulars about a new capability
  ${color.cyan("credits")}      generation credits — list / show / mode / grant / pause / apply / liability
  ${color.cyan("portal")}       per-person portal links — link <handle> / revoke <handle>
  ${color.cyan("config")}       show config sections (show [section], path, tidy)
  ${color.cyan("review")}       write this week's review sheet (--days 7, --sample 40)

${color.bold("Misc")}
  ${color.cyan("install")}      symlink this CLI into /opt/homebrew/bin
  ${color.cyan("help")}         this message

${color.bold("Flags")}
  --harness           target only the iMessage daemon
  --dashboard         target only the web dashboard
  --fishing           target only the fishing data API (:8087)
  --local             run in the foreground after uninstalling the launchd job
  --follow, -f        stream new output as it arrives
  -h, --help          per-command help
`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const p = parse(rest);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    print(HELP);
    return;
  }

  // Before any of them acts: `edmund restart --help` used to restart.
  const refusal = serviceCommandRefusal(cmd, p);
  if (refusal) {
    print(refusal.text);
    if (!refusal.help) process.exitCode = 2;
    return;
  }

  switch (cmd) {
    case "start":
      await startCommand(p);
      break;
    case "stop":
      await stopCommand(p);
      break;
    case "restart":
      await restartCommand(p);
      break;
    case "status":
      await statusCommand(p);
      break;
    case "kill":
      await killCommand(p);
      break;
    case "logs":
      await logsCommand(p);
      break;
    case "data":
      await dataCommand(p);
      break;
    case "dashboard":
      await dashboardCommand(p);
      break;
    case "cron":
      await cronCommand(p);
      break;
    case "sessions":
      await sessionsCommand(p);
      break;
    case "agents":
      await agentsCommand(p);
      break;
    case "skills":
      await skillsCommand(p);
      break;
    case "announce":
      await announceCommand(p);
      break;
    case "credits":
      await creditsCommand(p);
      break;
    case "portal":
      await portalCommand(p);
      break;
    case "review":
      await reviewCommand(p);
      break;
    case "config":
      await configCommand(p);
      break;
    case "install":
      await installCommand(p);
      break;
    default:
      fail(`unknown command: ${cmd}`);
      print(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
