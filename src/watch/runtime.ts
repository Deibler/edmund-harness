/**
 * The watch as the daemon runs it: the service with its real judge, its real
 * way of texting the operator, and its real hands for stopping a turn.
 *
 * `startWatch` is called once at boot. It plants the canaries, starts the
 * listener workers report to, and returns the three things the rest of the
 * daemon needs: what to do with a message from the operator that may be an
 * answer to an alert, what to do when a door opens that nobody registered,
 * and how to stop.
 */
import { copyFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { OperatorAlert } from "../alerts/operator-alert.ts";
import { evictWarmWorker, flushWorkerPool } from "../claude/runner.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import {
  findRecentMessageByText,
  getChatDisplayName,
  getGroupParticipants,
} from "../imessage/participants.ts";
import { isOperatorHandle } from "../security/policy.ts";
import { plantCanaries } from "../security/watch/canary.ts";
import type { Listener, Tunnel } from "../security/watch/exposure.ts";
import { isRegisteredTarget } from "../security/watch/gate.ts";
import { readWatchState, updateWatchState, watchDir } from "../security/watch/state.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import { currentBlocks, unblock, useBlocklist } from "../util/blocklist.ts";
import { log } from "../util/log.ts";
import { ChangeWatch } from "./changes.ts";
import { DRILL_FOLDER, drillSummary, lastDrillAt, runDrill } from "./drill.ts";
import { InboundWatch } from "./inbound-watch.ts";
import {
  type Incident,
  type UndoStep,
  alertMarker,
  newIncidentId,
  readReply,
} from "./incidents.ts";
import { askJudge } from "./judge.ts";
import { type LockdownDeps, lockdownOff, lockdownOn, runShell } from "./lockdown.ts";
import { type WatchServer, serveWatch } from "./server.ts";
import { Watch } from "./service.ts";

export type WatchRuntimeDeps = {
  config: Config;
  dataDir: string;
  repoRoot: string;
  alert: OperatorAlert;
  chatDb: ChatDb;
  contacts: ContactBook;
  /** Abort the turn running in a chat, if one is. */
  interruptTurn: (session: string, reason: string) => boolean;
  /** The chat guids of a session, for reading what was last said in it. */
  chatGuidsOf: (session: string) => string[];
  /** config.toml, whose shape the change watch keeps an eye on. */
  configPath: string;
  /** Where the servers' request logs are. */
  logsDir: string;
};

export type WatchRuntime = {
  watch: Watch;
  server: WatchServer | null;
  /**
   * A message from the operator. When it is for the watch (an OK, an UNDO, a
   * LOCKDOWN), returns what to do about it, which resolves to the answer to
   * send back; null when it is an ordinary message for the assistant. The
   * decision is made at once, because the caller has to route the message
   * before it can wait for anything.
   */
  operatorSaid: (session: string, text: string) => (() => Promise<string>) | null;
  /** A tunnel or listener appeared that was not there half a minute ago. */
  doorOpened: (opened: { tunnel?: Tunnel; listener?: Listener }) => Promise<void>;
  lockdown: LockdownDeps;
  /** Give the drill a way to read what is exposed now, without waiting for the timer. */
  setExposureSampler: (sample: () => Promise<void>) => void;
  stop: () => Promise<void>;
};

/**
 * Listeners macOS opens for its own services (AirPlay, Handoff, Screen
 * Sharing). They come and go on ports of their choosing, and are not doors
 * anyone here opened.
 */
const SYSTEM_LISTENERS = new Set([
  "rapportd",
  "ControlCenter",
  "ARDAgent",
  "sharingd",
  "AirPlayXPCHelper",
  "identityservicesd",
  "mDNSResponder",
  "launchd",
  "UniversalControl",
  "remoted",
  "screensharingd",
  "cupsd",
  "sshd",
  "smbd",
]);

/** The launchd label that started a process, when one did. */
function launchdLabel(pid: number): string | null {
  for (const line of runShell(["launchctl", "list"]).out.split("\n")) {
    const [p, , label] = line.trim().split(/\s+/);
    if (Number(p) === pid && label) return label;
  }
  return null;
}

/** The folder a process was started in. */
function cwdOf(pid: number): string {
  const out = runShell(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).out;
  return /^n(.+)$/m.exec(out)?.[1] ?? "";
}

const dmHandle = (session: string): string | null =>
  /^(?:imessage|sms):dm:/.test(session) ? chatIdFromKey(session) : null;

export function startWatch(deps: WatchRuntimeDeps): WatchRuntime {
  const { config, dataDir, repoRoot } = deps;
  const mode = config.watch.mode;
  if (mode !== "off") {
    const made = plantCanaries(dataDir, repoRoot);
    if (made.length > 0) log.info("watch", "canaries planted", { count: made.length });
  }

  const isOperatorChat = (session: string) => {
    const handle = dmHandle(session);
    return handle !== null && isOperatorHandle(config, handle);
  };
  const labelOf = (session: string) => {
    const handle = dmHandle(session);
    if (handle) return deps.contacts.displayName(handle) ?? "a direct chat";
    if (isGroupSession(session)) {
      const guid = deps.chatGuidsOf(session)[0];
      const name = guid ? getChatDisplayName(deps.chatDb, guid) : null;
      return name ? `the group "${name}"` : "a group chat";
    }
    return session.split(":")[0] === "agent" ? "a sub-agent" : `a ${session.split(":")[0]} session`;
  };

  const lockdown: LockdownDeps = {
    dataDir,
    repoRoot,
    flushWorkers: async () => {
      await flushWorkerPool();
    },
  };

  const watch = new Watch({
    config,
    dataDir,
    repoRoot,
    mode,
    judge: (record, flagged) =>
      askJudge("turn", record, flagged, {
        model: config.watch.judge_model,
        // The judge may run on past the hold: a late verdict still contains.
        timeoutMs: 45_000,
      }),
    holdMs: config.watch.hold_seconds * 1000,
    notify: (incident, text) =>
      deps.alert.sendText({ category: "security", signature: incident.id, text }),
    stopTurn: async (session, reason) => {
      const aborted = deps.interruptTurn(session, reason);
      const evicted = await evictWarmWorker(session, reason).catch(() => false);
      return aborted || evicted;
    },
    membersOf: (session) => {
      const handle = dmHandle(session);
      if (handle) return [handle];
      if (!isGroupSession(session)) return [];
      const guid = deps.chatGuidsOf(session)[0];
      return guid ? getGroupParticipants(deps.chatDb, guid) : [];
    },
    isOperatorChat,
    labelOf,
    knownHostsFile: join(watchDir(dataDir), "known-hosts.json"),
  });

  const reverse = async (step: UndoStep): Promise<string> => {
    switch (step.kind) {
      case "resume-session":
        updateWatchState(dataDir, (s) => {
          delete s.paused[step.session];
        });
        return `resumed ${labelOf(step.session)}`;
      case "restore-file":
        copyFileSync(step.from, step.path);
        return `restored ${step.path}`;
      case "restart": {
        const out = runShell(step.command.split(" "));
        return `${out.ok ? "restarted" : "could not restart"} ${step.detail}`;
      }
      case "unblock":
        return unblock(step.target)
          ? `unblocked ${step.target}`
          : `${step.target} was no longer blocked`;
    }
  };

  const operatorSaid = (session: string, text: string): (() => Promise<string>) | null => {
    if (mode === "off" || !isOperatorChat(session)) return null;
    const open = watch.incidents.open();
    const newest = open[0];
    const lastSaidWasAlert =
      newest !== undefined &&
      findRecentMessageByText(deps.chatDb, deps.chatGuidsOf(session), alertMarker(newest.id), {
        lookback: 3,
        requireFromMe: true,
      }) !== null;
    const reply = readReply(text, open, lastSaidWasAlert, Date.now());
    if (!reply) return null;
    if (reply.word === "lockdown") {
      return async () => {
        const result = await lockdownOn(lockdown, "the operator's text");
        return `Lockdown ${result.changed ? "on" : "was already on"}: ${result.did.join("; ")}. Text LOCKDOWN OFF or run \`edmund lockdown off\` to lift it.`;
      };
    }
    if (reply.word === "lockdown-off") {
      return async () => {
        const result = await lockdownOff(lockdown, "the operator's text");
        return `Lockdown ${result.changed ? "lifted" : "was not on"}: ${result.did.join("; ")}.`;
      };
    }
    if (!("incident" in reply)) return null;
    const { incident, word } = reply;
    return async () => {
      const done = await watch.resolve(incident, word === "ok", reverse);
      const what = done.length > 0 ? done.join("; ") : "nothing needed reversing";
      return `${word.toUpperCase()} ${incident.id}: ${what}.`;
    };
  };

  // Where the assistant's work is done: a process started there is its own.
  const sandboxes = [join(repoRoot, "sandbox")];
  try {
    sandboxes.push(realpathSync(join(repoRoot, "sandbox")));
  } catch {}

  /**
   * A door that did not come through the gate. One the assistant opened is
   * closed, with how to start it again written down. One whose owner cannot
   * be told is reported and left alone: the operator works on this machine
   * too, and a watch that kills their dev server will be switched off.
   */
  const doorOpened = async (opened: { tunnel?: Tunnel; listener?: Listener }): Promise<void> => {
    if (mode === "off") return;
    const pid = opened.tunnel?.pid ?? opened.listener?.pid ?? 0;
    if (!pid) return;
    if (opened.listener && SYSTEM_LISTENERS.has(opened.listener.command)) return;
    if (opened.tunnel?.kind === "quick" && isRegisteredTarget(dataDir, opened.tunnel.target))
      return;
    // A service this checkout installed (the dashboard, the portal's tunnel) restarting.
    if (launchdLabel(pid)) return;

    const what = opened.tunnel
      ? `a ${opened.tunnel.kind} tunnel to ${opened.tunnel.target}`
      : `${opened.listener!.command} listening on every interface, port ${opened.listener!.port}`;
    const pattern = opened.tunnel
      ? `door|tunnel:${opened.tunnel.target}|machine`
      : `door|${opened.listener!.command}:${opened.listener!.port}|machine`;
    if (pattern in readWatchState(dataDir).allowed) return;

    const cwd = cwdOf(pid);
    const assistants =
      cwd !== "" && sandboxes.some((root) => cwd === root || cwd.startsWith(`${root}/`));
    const incident: Incident = {
      id: newIncidentId(),
      at: Date.now(),
      where: cwd ? `started in ${cwd}` : `pid ${pid}`,
      kind: "unplanned-door",
      tier: "serious",
      what: `${what} was opened without going through the publish gate`,
      verdict: "rule",
      judged: "",
      pattern,
      did: [],
      undo: [],
      status: "open",
      ...(cwd.includes(`/${DRILL_FOLDER}`) ? { drill: true as const } : {}),
    };
    if (assistants && mode === "enforce") {
      const command = runShell(["/bin/ps", "-o", "command=", "-p", String(pid)]).out;
      const closed = runShell(["kill", String(pid)]).ok;
      incident.did.push(closed ? "closed it" : "could not close it");
      if (closed && command) incident.undo.push({ kind: "restart", detail: what, command });
    } else if (!assistants) {
      incident.did.push("left it open: it was not started from one of the assistant's folders");
    }
    await watch.record(incident);
  };

  if (mode === "off") {
    return {
      watch,
      server: null,
      operatorSaid,
      doorOpened,
      lockdown,
      setExposureSampler: () => {},
      stop: async () => {},
    };
  }

  watch.start();
  const changes = new ChangeWatch({
    dataDir,
    repoRoot,
    configPath: deps.configPath,
    workerTouched: (what) => watch.workerTouched(what),
    record: (incident) => watch.record(incident),
  });
  changes.start();
  // Who is knocking: every server's request log, scored, and reviewed only on harm or persistence.
  useBlocklist(join(watchDir(dataDir), "blocked.json"));
  const inbound = new InboundWatch({
    dataDir,
    logsDir: deps.logsDir,
    mode,
    judge: (record, flagged) =>
      askJudge("inbound", record, flagged, { model: config.watch.judge_model, timeoutMs: 45_000 }),
    record: (incident) => watch.record(incident),
  });
  inbound.start();
  const server = serveWatch(watch, dataDir, async (action, body) => {
    switch (action) {
      case "status": {
        const state = readWatchState(dataDir);
        return {
          ok: true,
          mode,
          counts: watch.counts,
          inbound: {
            ...inbound.counts,
            tracked: inbound.inbound.size(),
            blocked_now: Object.keys(currentBlocks()).length,
          },
          slowest_ms: Math.round(server.slowest()),
          lockdown: state.lockdown,
          paused: state.paused,
          allowed: Object.keys(state.allowed).length,
          open: watch.incidents
            .open()
            .map((i) => ({ id: i.id, at: i.at, kind: i.kind, what: i.what })),
        };
      }
      case "lockdown":
        return { ok: true, ...(await lockdownOn(lockdown, String(body.by ?? "the command line"))) };
      case "lockdown-off":
        return {
          ok: true,
          ...(await lockdownOff(lockdown, String(body.by ?? "the command line"))),
        };
      case "resume": {
        const session = String(body.session ?? "");
        const state = readWatchState(dataDir);
        const targets = session ? [session] : Object.keys(state.paused);
        updateWatchState(dataDir, (s) => {
          for (const t of targets) delete s.paused[t];
        });
        return { ok: true, resumed: targets };
      }
      case "answer": {
        const incident = watch.incidents
          .all()
          .find((i) => i.id === String(body.id ?? "").toUpperCase());
        if (!incident) return { ok: false, error: "no such incident" };
        return { ok: true, did: await watch.resolve(incident, body.word !== "undo", reverse) };
      }
      case "reload":
        watch.reloadSecrets();
        return { ok: true };
      case "drill":
        return { ok: true, mode, results: await drill(String(body.by ?? "the command line")) };
      default:
        return { ok: false, error: `unknown action ${action}` };
    }
  });
  log.info("watch", "listening for worker tool calls", { port: server.address.port });

  let sampleExposure: () => Promise<void> = async () => {};
  let drilling = false;
  /** Run the fire drill and text the operator the result. One at a time. */
  const drill = async (by: string) => {
    if (drilling) return [];
    drilling = true;
    try {
      const results = await runDrill({ watch, inbound, dataDir, repoRoot, sampleExposure });
      await deps.alert
        .sendText({
          category: "security",
          signature: `drill:${Date.now()}`,
          text: drillSummary(results, mode === "enforce"),
        })
        .catch(() => false);
      log.info("watch", "drill finished", { by, scenarios: results.length });
      return results;
    } finally {
      drilling = false;
    }
  };
  // Once a month, on its own, at a moment the machine is not locked down.
  const MONTH_MS = 30 * 24 * 3_600_000;
  const drillTimer = setInterval(() => {
    const last = lastDrillAt(dataDir);
    if (last > 0 && Date.now() - last >= MONTH_MS && !readWatchState(dataDir).lockdown) {
      void drill("the monthly schedule");
    }
  }, 6 * 3_600_000);
  drillTimer.unref?.();

  return {
    watch,
    server,
    operatorSaid,
    doorOpened,
    lockdown,
    setExposureSampler: (sample) => {
      sampleExposure = sample;
    },
    stop: async () => {
      clearInterval(drillTimer);
      changes.stop();
      inbound.stop();
      server.stop();
      await watch.stop();
    },
  };
}
