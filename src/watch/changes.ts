/**
 * The change watch: the files that make something run again later, looked
 * at every five minutes.
 *
 * A tripwire sees a worker write to one of these as it happens. This sees
 * the write however it was made: by a script the worker ran, by an
 * installer, by hand. Each watched file is kept as a copy from the last
 * look, so a change is known for what it was, and can be put back.
 *
 * What is watched: the user's LaunchAgents, the crontab, the shell
 * profiles, `~/.ssh/authorized_keys`, cloudflared's configuration, the
 * assistant's standing instructions, and config.toml.
 *
 * config.toml is read for its shape, never its values: which keys exist,
 * and a fingerprint of the `[security]` section and of every webhook
 * address. A hand edit elsewhere in it is not news. A change to who is
 * trusted, or to where events are sent, is.
 *
 * The assistant's own memory files change all day through its own tools,
 * so a change to one is recorded and kept, and raised only when a worker
 * touched the file directly, which the tripwire reports.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWatchState, watchDir } from "../security/watch/state.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { log } from "../util/log.ts";
import { type Incident, newIncidentId } from "./incidents.ts";
import { type Shell, runShell } from "./lockdown.ts";

type Target = {
  /** A name for the log and the alert. */
  what: string;
  /** How a change is treated: raised as an incident, or only recorded. */
  raise: boolean;
  /** The files it covers, as paths, or a function that lists them. */
  files: () => string[];
};

const HOME = homedir();
const inHome = (...parts: string[]) => join(HOME, ...parts);

function listed(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function defaultTargets(repoRoot: string): Target[] {
  return [
    {
      what: "a LaunchAgent",
      raise: true,
      files: () => listed(inHome("Library", "LaunchAgents"), /\.plist$/),
    },
    {
      what: "a shell profile",
      raise: true,
      files: () =>
        [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".bash_profile", ".profile"].map(
          (name) => inHome(name),
        ),
    },
    { what: "ssh access", raise: true, files: () => [inHome(".ssh", "authorized_keys")] },
    {
      what: "a cloudflared config",
      raise: true,
      files: () => listed(inHome(".cloudflared"), /\.(ya?ml|json)$/),
    },
    {
      what: "the assistant's standing instructions",
      raise: false,
      files: () => ["AGENTS.md", "SOUL.md", "IDENTITY.md"].map((n) => join(repoRoot, "persona", n)),
    },
  ];
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/**
 * config.toml as the watch keeps it: the key names, and fingerprints of the
 * parts whose change matters. Read line by line, on purpose: this must not
 * hold a credential, and a parser would hand it every one.
 */
export function configShape(text: string): { keys: string[]; security: string; webhooks: string } {
  const keys: string[] = [];
  const security: string[] = [];
  const webhooks: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = section ? `${section}.${pair[1]}` : pair[1]!;
    keys.push(key);
    if (section === "security" || section.startsWith("security.")) security.push(line);
    // Collected whole and fingerprinted together below: no value outlives this function.
    if (/webhook|callback|(^|[._])url$|origin$/i.test(key)) webhooks.push(line);
  }
  return {
    keys: keys.sort(),
    security: sha(security.join("\n")),
    webhooks: sha(webhooks.join("\n")),
  };
}

type Seen = Record<string, string>;

export type ChangeWatchDeps = {
  dataDir: string;
  repoRoot: string;
  configPath: string;
  targets?: Target[];
  shell?: Shell;
  /** True when a worker's own write to this kind of file was seen since the last look. */
  workerTouched: (what: string) => boolean;
  /** Raise an incident. */
  record: (incident: Incident) => Promise<void>;
  now?: () => number;
};

/** A file name safe to use for the copy of another file. */
const copyName = (path: string) => path.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-180);

export class ChangeWatch {
  private readonly dir: string;
  private readonly seenFile: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ChangeWatchDeps) {
    this.dir = join(watchDir(deps.dataDir), "snapshots");
    this.seenFile = join(watchDir(deps.dataDir), "changes.json");
  }

  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;
    void this.look();
    this.timer = setInterval(() => void this.look(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readSeen(): Seen | null {
    try {
      return JSON.parse(readFileSync(this.seenFile, "utf8")) as Seen;
    } catch {
      return null;
    }
  }

  /**
   * Compare everything watched with the last look. The first look only
   * takes copies: whatever is there then is what "unchanged" means.
   */
  async look(): Promise<string[]> {
    const before = this.readSeen();
    const first = before === null;
    const now: Seen = {};
    const changed: string[] = [];
    mkdirSync(this.dir, { recursive: true });
    const targets = this.deps.targets ?? defaultTargets(this.deps.repoRoot);

    for (const target of targets) {
      for (const path of target.files()) {
        let content: Buffer | null = null;
        try {
          if (statSync(path).isFile()) content = readFileSync(path);
        } catch {}
        const digest = content ? sha(content) : "absent";
        now[path] = digest;
        const was = before?.[path];
        const copy = join(this.dir, copyName(path));
        if (!first && was !== undefined && was !== digest) {
          changed.push(path);
          await this.changedFile(target, path, was, digest, copy);
        } else if (!first && was === undefined && content) {
          changed.push(path);
          await this.changedFile(target, path, "absent", digest, copy);
        }
        // The copy is what the file was at this look, for the next one to restore from.
        if (content) {
          if (existsSync(copy) && was !== digest) copyFileSync(copy, `${copy}.prev`);
          atomicWriteFileSync(copy, content);
        }
      }
    }

    const shell = this.deps.shell ?? runShell;
    const cron = shell(["crontab", "-l"]);
    const cronText = cron.ok ? cron.out : "";
    now.crontab = sha(cronText);
    if (!first && before?.crontab !== undefined && before.crontab !== now.crontab) {
      changed.push("crontab");
      await this.raise("the crontab", "crontab", "the crontab changed", []);
    }

    try {
      const shape = configShape(readFileSync(this.deps.configPath, "utf8"));
      now["config:keys"] = sha(shape.keys.join("\n"));
      now["config:security"] = shape.security;
      now["config:webhooks"] = shape.webhooks;
      if (!first) {
        if (before?.["config:security"] && before["config:security"] !== shape.security) {
          changed.push("config.toml [security]");
          await this.raise(
            "config.toml",
            "config:security",
            "the [security] section of config.toml changed",
            [],
          );
        }
        if (before?.["config:webhooks"] && before["config:webhooks"] !== shape.webhooks) {
          changed.push("config.toml webhooks");
          await this.raise(
            "config.toml",
            "config:webhooks",
            "a webhook or public address in config.toml changed",
            [],
          );
        }
        if (before?.["config:keys"] && before["config:keys"] !== now["config:keys"]) {
          log.event("security", "watch", "config.toml gained or lost a key", { kind: "changed" });
        }
      }
    } catch {
      // No config to read here.
    }

    atomicWriteFileSync(this.seenFile, `${JSON.stringify(now)}\n`);
    return changed;
  }

  private async changedFile(
    target: Target,
    path: string,
    was: string,
    is: string,
    copy: string,
  ): Promise<void> {
    const how = was === "absent" ? "was created" : is === "absent" ? "was removed" : "changed";
    const byWorker = this.deps.workerTouched(target.what);
    log.event(
      "security",
      "watch",
      `${target.what} ${how}: ${path}`,
      { kind: "changed", path, by_worker: byWorker || undefined },
      target.raise ? "warn" : "info",
    );
    // A worker's direct write was judged when it happened; this is the record of what it did.
    if (!target.raise && !byWorker) return;
    // The copy still holds the file as it was at the last look.
    const undo =
      was !== "absent" && existsSync(copy)
        ? [{ kind: "restore-file" as const, path, from: `${copy}.prev` }]
        : [];
    await this.raise(target.what, path, `${target.what} ${how}: ${path}`, undo, byWorker);
  }

  private async raise(
    what: string,
    target: string,
    text: string,
    undo: Incident["undo"],
    byWorker = this.deps.workerTouched(what),
  ): Promise<void> {
    const pattern = `changed|${target}|machine`;
    if (pattern in readWatchState(this.deps.dataDir).allowed) return;
    await this.deps.record({
      id: newIncidentId(),
      at: (this.deps.now ?? Date.now)(),
      where: "this machine",
      kind: "changed",
      // A worker's change is the serious one; anyone else's is on the record to look at.
      tier: byWorker ? "serious" : "notable",
      what: byWorker ? `${text}, during a turn that wrote to it` : text,
      verdict: "rule",
      judged: "",
      pattern,
      did: undo.length > 0 ? ["kept a copy of the earlier version"] : [],
      undo,
      status: "open",
    });
  }
}
