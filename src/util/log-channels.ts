/**
 * The log channels, and which channel each log tag belongs to.
 *
 * `logs/daemon.log` stays the one operational log, every line in the order it
 * happened. Each line is also written, as a JSON record, to a channel file
 * under `logs/<channel>/<day>.jsonl`, so one subject can be read on its
 * own: only the model's turns, only the scheduler, only what came in over the
 * network. Some channels hold records that never reach daemon.log because
 * there are too many of them to read in passing (`net-out`, `net-in`, `proc`,
 * `resource`, `browse`).
 *
 * A tag used in the code has to be in TAG_CHANNEL: `tests/log-channels.test.ts`
 * reads every tag out of the source and fails on one that is missing, so a
 * new subsystem's lines are filed on purpose and not left in `misc`.
 */

export const CHANNELS = {
  model:
    "Model turns: workers, the pool, tool use as the model asked for it, usage, compaction, fallbacks.",
  tool: "Tool calls as the MCP servers ran them: arguments, duration, result, including screen control.",
  message:
    "Messages in and out: the watcher, the bridge, sends and their verification, the outbox, SMS.",
  cron: "Scheduled jobs: fires, skips, retries, wake-ups, refresh scripts, recovery sweeps.",
  trigger: "Data triggers: what was armed, evaluated and fired.",
  ghost: "Proactive work: the ghost's decisions and fires, ideation pages, announcements.",
  agent: "Sub-agents and background jobs: spawn, progress, result.",
  memory:
    "Recall, the memory maintainers, persona archiving and consolidation, skill curation, the sandbox reaper.",
  call: "Voice: FaceTime calls, the transcriber, the turn detector, speech.",
  integration:
    "Optional packages and side services: printer, mirror, radar, Grok, portal, dashboard, credits.",
  security:
    "Who was let in and who was not: inbound gating, guest tiers and caps, addressing decisions, refused sends and actions, and every 401, 403 and 429 a server answered.",
  "net-out":
    "Every HTTP request this process made: host, path, status, duration. No query strings, headers or bodies.",
  "net-in":
    "Every HTTP request a harness server answered: server, method, path, status, duration, caller.",
  browse: "What the model opened on the web: pages, fetches and searches, by conversation.",
  proc: "Every child process: command, pid, exit code or signal, duration; and the process tree as the system reports it.",
  resource:
    "Memory, CPU, GPU, swap, disk and thermal state once a minute, with the largest processes; the resource governor's decisions; main thread stalls.",
  system: "Start-up, shutdown, configuration, operator alerts, and the logger's own notices.",
  error:
    "A copy of every warning and error from every channel, and any exception that ended a process, with its stack.",
  misc: "Lines whose tag is not filed yet.",
} as const;

export type Channel = keyof typeof CHANNELS;

export const CHANNEL_NAMES = Object.keys(CHANNELS) as Channel[];

export function isChannel(name: string): name is Channel {
  return Object.hasOwn(CHANNELS, name);
}

const BY_CHANNEL: Partial<Record<Channel, string[]>> = {
  model: [
    "claude",
    "claude-worker",
    "claude-pool",
    "codex",
    "auto-compact",
    "mid-turn",
    "session",
    "session-lock",
    "session-queue",
    "model",
    "model-scorecard",
    "one-shot",
    "fallback",
    "inline-images",
    "image-resize",
    "mcp-config",
    "cli-canary",
    "turn-workers",
    "spend",
    "loadout",
    "pipeline",
  ],
  tool: [
    "tool",
    "mcp",
    "computer",
    "send_message",
    "send_attachment",
    "send_location",
    "react",
    "check_incoming",
    "activate_typing",
    "unsend_message",
    "edit_message",
    "delete_message",
    "create_chat",
    "set_group_photo",
    "rename_group",
    "remove_group_member",
    "add_group_member",
    "leave_group",
    "video-transcode",
    "video-analyze",
    "transcribe",
    "instant-share",
  ],
  message: [
    "inbound",
    "outbound",
    "watcher",
    "bridge",
    "bridge-control",
    "bridge-events",
    "send",
    "send-verify",
    "deliver",
    "outbox",
    "outbox-drain",
    "heal",
    "liveness",
    "catchup",
    "catch-up",
    "sms",
    "copy-received",
    "auto-typing",
    "address-book",
    "imessage-action",
    "relay-media",
  ],
  cron: ["cron", "sched", "wake", "refresh", "refresh-watcher", "recovery"],
  trigger: ["trigger", "triggers", "trigger-watcher", "harness-trigger"],
  ghost: [
    "ghost",
    "ghost-observer",
    "brown-nose",
    "brown-nose-fire",
    "brown-nose-outcome",
    "brown-nose-queue",
    "ideation",
    "announce",
  ],
  agent: ["agent", "agents", "agent-runner", "bg", "bg-jobs", "bg-runner"],
  memory: [
    "recall",
    "maintainer",
    "persona",
    "persona-maintainer",
    "persona-archive",
    "persona-consolidate",
    "skill-curator",
    "reaper",
    "sandbox-reaper",
    "evals",
  ],
  call: ["calls", "facetime", "transcriber", "voice-lab", "turn", "barge-in"],
  integration: [
    "integrations",
    "printer",
    "mirror",
    "radaromega",
    "camera-host",
    "grok",
    "portal",
    "dashboard",
    "pay",
    "credits",
  ],
  security: ["gate", "guest", "addressing", "security"],
  resource: ["resources", "loop"],
  system: ["edmund-harness", "boot", "shutdown", "config", "fatal", "alert", "log", "data"],
};

const TAG_CHANNEL = new Map<string, Channel>();
for (const [channel, tags] of Object.entries(BY_CHANNEL) as [Channel, string[]][]) {
  for (const tag of tags) TAG_CHANNEL.set(tag, channel);
}

/** True when the tag has been filed under a channel. */
export function isFiledTag(tag: string): boolean {
  return TAG_CHANNEL.has(tag);
}

/** The channel a tag's lines go to; `misc` for a tag nobody has filed. */
export function channelForTag(tag: string): Channel {
  return TAG_CHANNEL.get(tag) ?? "misc";
}

/**
 * Lines from any channel that are also a security event: something was
 * refused, denied or cut off. `\b` keeps ECONNREFUSED, a network failure, out.
 */
const SECURITY_EVENT =
  /\b(chat_mismatch|refused|denied|forbidden|unauthori[sz]ed|not allowed|not permitted|blocked|revoked|capped|rate.?limit(ed)?|invalid (pin|token|signature|code|key))\b/i;

/** Whether a line filed elsewhere is copied to the security channel as well. */
export function isSecurityEvent(message: string): boolean {
  return SECURITY_EVENT.test(message);
}
