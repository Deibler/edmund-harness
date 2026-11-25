/**
 * The parts of the watch that stand between the assistant and the outside:
 * the publish gate, the operator's answers, lockdown, and the settings that
 * put a worker under watch in the first place.
 *
 * On 2026-11-25 a share had been started with an expiry of 525,600 minutes
 * and nothing had looked at what was in its folder. And `OK` is a word
 * people say all day: an answer to an alert has to be told from one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postCompactHookSettings, workerSettings } from "../src/model/direct-env.ts";
import {
  mergeSettings,
  readWatchAddress,
  watchHookSettings,
} from "../src/security/watch/address.ts";
import {
  canaryEntries,
  canaryPaths,
  loadSecrets,
  plantCanaries,
} from "../src/security/watch/canary.ts";
import {
  expiryProblem,
  isRegisteredTarget,
  longSharePattern,
  registerDoor,
  scanFolder,
} from "../src/security/watch/gate.ts";
import { readWatchState, updateWatchState } from "../src/security/watch/state.ts";
import { type Incident, alertMarker, alertText, readReply } from "../src/watch/incidents.ts";
import { parseVerdict } from "../src/watch/judge.ts";
import { type Shell, lockdownOff, lockdownOn } from "../src/watch/lockdown.ts";

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "watch-gate-"));
  dataDir = join(root, "data");
  mkdirSync(join(dataDir, "secrets"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("canaries", () => {
  test("are planted once, are unique, and are found by value with every other secret", () => {
    expect(plantCanaries(dataDir, root)).toHaveLength(2);
    expect(plantCanaries(dataDir, root)).toEqual([]);
    const first = canaryEntries(dataDir, root).map((e) => e.value);
    expect(first.length).toBeGreaterThanOrEqual(5);
    const other = mkdtempSync(join(tmpdir(), "watch-gate-other-"));
    try {
      mkdirSync(join(other, "data", "secrets"), { recursive: true });
      plantCanaries(join(other, "data"), other);
      const second = canaryEntries(join(other, "data"), other).map((e) => e.value);
      expect(first.some((v) => second.includes(v))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    writeFileSync(join(dataDir, "secrets", "tunnel-token"), "t".repeat(48));
    const scanner = loadSecrets({ keys: { brave: "b".repeat(32) } }, dataDir, root);
    const token = readFileSync(canaryPaths(dataDir, root).token, "utf8");
    // The canary file is a canary, not also a real secret.
    expect(scanner.find(token).map((h) => h.kind)).toEqual(["canary"]);
    expect(scanner.find(`x ${"t".repeat(48)} y`)[0]).toMatchObject({
      name: "file:secrets/tunnel-token",
    });
    expect(scanner.find("b".repeat(32))[0]).toMatchObject({ name: "config:keys.brave" });
  });
});

describe("the publish gate", () => {
  const scanner = () => {
    plantCanaries(dataDir, root);
    return loadSecrets({ keys: { openrouter: "o".repeat(40) } }, dataDir, root);
  };

  test("a folder of pages may go", () => {
    const folder = join(root, "share");
    mkdirSync(join(folder, "assets"), { recursive: true });
    writeFileSync(join(folder, "index.html"), "<html>dinner</html>");
    writeFileSync(join(folder, "artifact.json"), '{"name":"dinner"}');
    writeFileSync(
      join(folder, "assets", "app.js"),
      "console.log('https://example.com/?key=J3kd9sQ2mPz8Lw4n')",
    );
    writeFileSync(join(folder, ".env.example"), "API_KEY=your-key-here");
    expect(scanFolder(folder, scanner())).toEqual([]);
  });

  test("files that hold credentials, by name or by what is in them, may not", () => {
    const s = scanner();
    const folder = join(root, "share");
    mkdirSync(join(folder, ".git"), { recursive: true });
    mkdirSync(join(folder, "js"), { recursive: true });
    writeFileSync(join(folder, ".env"), "X=1");
    writeFileSync(join(folder, "deploy.token"), "abc");
    writeFileSync(join(folder, "id_ed25519"), "key");
    writeFileSync(join(folder, "js", "config.js"), `const k = "${"o".repeat(40)}";`);
    writeFileSync(join(folder, "notes.txt"), `aws ${canaryEntries(dataDir, root)[0]!.value}`);
    writeFileSync(join(folder, "readme.md"), `token: ghp_${"a".repeat(36)}`);
    symlinkSync("/etc/hosts", join(folder, "hosts"));
    const found = scanFolder(folder, s)
      .map((p) => `${p.file} ${p.why}`)
      .sort();
    expect(found).toEqual([
      ".env is an environment file",
      ".git is a repository",
      "deploy.token is a token file",
      "hosts is a link to somewhere outside the folder",
      "id_ed25519 is a private key",
      "js/config.js contains config:keys.openrouter",
      "notes.txt contains canary:secrets/aws-backup.token",
      "readme.md contains something shaped like a github key",
    ]);
  });

  test("a share expires within the limit unless the operator allowed that folder longer", () => {
    const folder = "/sandbox/share-a";
    expect(expiryProblem(60, 30, folder, dataDir)).toBeNull();
    expect(expiryProblem(30 * 1440, 30, folder, dataDir)).toBeNull();
    expect(expiryProblem(525_600, 30, folder, dataDir)).toContain("365 days");
    expect(expiryProblem(0, 30, folder, dataDir)).toContain("no expiry at all");
    expect(expiryProblem(Number.NaN, 30, folder, dataDir)).toContain("no expiry at all");
    updateWatchState(dataDir, (s) => {
      s.allowed[longSharePattern(folder)] = Date.now();
    });
    expect(expiryProblem(525_600, 30, folder, dataDir)).toBeNull();
    expect(expiryProblem(525_600, 30, "/sandbox/other", dataDir)).not.toBeNull();
  });

  test("a door is known by its port until it expires", () => {
    const now = 1_000_000;
    registerDoor(
      dataDir,
      { port: 62294, artifact: "a1", path: "/s/a", expiresAt: now + 60_000, registeredAt: now },
      now,
    );
    expect(isRegisteredTarget(dataDir, "http://127.0.0.1:62294", now)).toBe(true);
    expect(isRegisteredTarget(dataDir, "http://127.0.0.1:62295", now)).toBe(false);
    expect(isRegisteredTarget(dataDir, "http://127.0.0.1:62294", now + 120_000)).toBe(false);
    // The same port again is the newer door.
    registerDoor(
      dataDir,
      { port: 62294, artifact: "a2", path: "/s/b", expiresAt: now + 900_000, registeredAt: now },
      now,
    );
    expect(isRegisteredTarget(dataDir, "http://127.0.0.1:62294/", now + 120_000)).toBe(true);
  });
});

describe("the operator's answer to an alert", () => {
  const incident = (id: string, at: number, over: Partial<Incident> = {}): Incident => ({
    id,
    at,
    where: "a friend (Bash)",
    kind: "secret-then-new-host",
    tier: "serious",
    what: "after reading an ssh key, the turn would send data to paste.example.io",
    verdict: "serious",
    judged: "A dinner question does not explain it.",
    pattern: "secret-then-new-host|example.io|imessage:dm:+15550100060",
    did: ["refused the call", "paused this chat"],
    undo: [{ kind: "resume-session", session: "imessage:dm:+15550100060" }],
    status: "open",
    ...over,
  });
  const NOW = 10_000_000;
  const open = [incident("K7Q2", NOW - 60_000), incident("M4XD", NOW - 3_600_000)];

  test("a bare OK or UNDO answers the alert only when it directly follows it", () => {
    expect(readReply("OK", open, true, NOW)).toMatchObject({
      word: "ok",
      incident: { id: "K7Q2" },
    });
    expect(readReply("undo.", open, true, NOW)).toMatchObject({
      word: "undo",
      incident: { id: "K7Q2" },
    });
    expect(readReply("ok", open, false, NOW)).toBeNull();
    // Too long ago to be an answer to it.
    expect(readReply("ok", [incident("K7Q2", NOW - 45 * 60_000)], true, NOW)).toBeNull();
    expect(readReply("ok", [], true, NOW)).toBeNull();
  });

  test("an OK that names the incident answers it whenever it is sent", () => {
    expect(readReply("ok m4xd", open, false, NOW)).toMatchObject({
      word: "ok",
      incident: { id: "M4XD" },
    });
    expect(readReply("UNDO #K7Q2", open, false, NOW)).toMatchObject({
      word: "undo",
      incident: { id: "K7Q2" },
    });
    // Four characters that are not an incident are just what the person said.
    expect(readReply("ok cool", open, true, NOW)).toBeNull();
    expect(readReply("ok ZZZZ", open, false, NOW)).toBeNull();
    const answered = [incident("K7Q2", NOW - 60_000, { status: "ok" })];
    expect(readReply("ok K7Q2", answered, false, NOW)).toBeNull();
  });

  test("ordinary messages are for the assistant", () => {
    for (const said of [
      "ok thanks",
      "OK so what about dinner",
      "okay sounds good",
      "undo that last change",
      "lock it down",
      "k",
    ]) {
      expect(readReply(said, open, true, NOW)).toBeNull();
    }
  });

  test("LOCKDOWN needs no incident and no id", () => {
    expect(readReply("LOCKDOWN", [], false, NOW)).toEqual({ word: "lockdown" });
    expect(readReply("lockdown!", open, false, NOW)).toEqual({ word: "lockdown" });
    expect(readReply("Lockdown off", [], false, NOW)).toEqual({ word: "lockdown-off" });
    expect(readReply("lockdown the house", [], false, NOW)).toBeNull();
  });

  test("the alert says what happened, what was done, and how to answer", () => {
    const text = alertText(open[0]!, false);
    expect(text.startsWith(alertMarker("K7Q2"))).toBe(true);
    expect(text).toContain("Where: a friend (Bash)");
    expect(text).toContain("Reviewed as serious: A dinner question does not explain it.");
    expect(text).toContain("Done: refused the call; paused this chat.");
    expect(text).toContain(
      "Reply OK K7Q2 (it was fine, don't raise it again), UNDO K7Q2 (reverse what I did), LOCKDOWN.",
    );
    const nothingDone = alertText(incident("AB23", NOW, { did: [], undo: [], pattern: "" }), true);
    expect(nothingDone).toContain("observe mode: nothing was stopped");
    expect(nothingDone).toContain("Reply OK AB23 (it was fine), LOCKDOWN.");
    expect(alertText(incident("DR11", NOW, { drill: true }), false)).toStartWith("DRILL. ");
  });
});

describe("the judge's answer", () => {
  test("is read however the model wraps it", () => {
    expect(parseVerdict('{"verdict":"serious","why":"an ssh key  went to a paste site"}')).toEqual({
      verdict: "serious",
      why: "an ssh key went to a paste site",
    });
    // Haiku 4.5 fenced its answer; a preamble is not a reason to have no verdict.
    expect(
      parseVerdict('Here you go:\n```json\n{"verdict":"benign","why":"fits"}\n```')?.verdict,
    ).toBe("benign");
    expect(parseVerdict('{"verdict":"suspicious"}')).toEqual({
      verdict: "suspicious",
      why: "(no reason given)",
    });
  });

  test("anything that is not one of the three levels is no verdict", () => {
    for (const text of [
      "",
      "I cannot help with that.",
      '{"verdict":"fine","why":"x"}',
      "{not json}",
      '{"why":"only a reason"}',
    ]) {
      expect(parseVerdict(text)).toBeNull();
    }
  });
});

describe("lockdown", () => {
  const PS = [
    "  101 /opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:62294",
    "  202 /opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:4749",
    "  303 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run --token-file /x/data/secrets/kitchen-tunnel-token",
    "  404 bun src/main.ts",
  ].join("\n");

  function shellWith(ran: string[][]): Shell {
    return (argv) => {
      ran.push(argv);
      if (argv[0] === "ps") return { ok: true, out: PS };
      if (argv[0] === "launchctl" && argv[1] === "list") {
        return {
          ok: true,
          out: "PID\tStatus\tLabel\n202\t0\tcom.edmund-harness.portal-tunnel\n404\t0\tcom.edmund-harness",
        };
      }
      return { ok: true, out: "" };
    };
  }

  test("closes the quick tunnels, leaves the named ones, and sets the flag first", async () => {
    const ran: string[][] = [];
    let flushed = 0;
    let lockedWhenFlushed = false;
    const result = await lockdownOn(
      {
        dataDir,
        repoRoot: root,
        shell: shellWith(ran),
        uid: 501,
        flushWorkers: () => {
          flushed++;
          lockedWhenFlushed = readWatchState(dataDir).lockdown !== null;
        },
      },
      "a test",
    );
    expect(result).toMatchObject({ on: true, changed: true });
    const acted = ran.filter((a) => a[0] === "kill" || a[1] === "bootout").map((a) => a.join(" "));
    expect(acted).toEqual([
      "kill 101",
      "launchctl bootout gui/501/com.edmund-harness.portal-tunnel",
    ]);
    expect(flushed).toBe(1);
    expect(lockedWhenFlushed).toBe(true);
    const state = readWatchState(dataDir).lockdown!;
    expect(state.by).toBe("a test");
    expect(state.restore.map((r) => r.detail)).toEqual([
      "quick tunnel to http://127.0.0.1:62294 (pid 101)",
      "quick tunnel to http://127.0.0.1:4749 (com.edmund-harness.portal-tunnel)",
    ]);
    // Twice changes nothing the second time.
    const again = await lockdownOn(
      { dataDir, repoRoot: root, shell: shellWith(ran), uid: 501 },
      "a test",
    );
    expect(again.changed).toBe(false);
  });

  test("off clears the flag and says what it could and could not bring back", async () => {
    const ran: string[][] = [];
    updateWatchState(dataDir, (s) => {
      s.lockdown = {
        since: 1,
        by: "a test",
        restore: [
          { kind: "tunnel", detail: "quick tunnel (pid 101)" },
          {
            kind: "tunnel",
            detail: "the portal's tunnel",
            command: "launchctl bootstrap gui/501 /x/portal.plist",
          },
        ],
      };
    });
    const result = await lockdownOff(
      { dataDir, repoRoot: root, shell: shellWith(ran), uid: 501 },
      "a test",
    );
    expect(result.changed).toBe(true);
    expect(ran).toEqual([["launchctl", "bootstrap", "gui/501", "/x/portal.plist"]]);
    expect(result.did.slice(0, 2)).toEqual([
      "not restarted: quick tunnel (pid 101)",
      "restarted: the portal's tunnel",
    ]);
    expect(readWatchState(dataDir).lockdown).toBeNull();
    expect(
      (await lockdownOff({ dataDir, repoRoot: root, shell: shellWith(ran) }, "a test")).changed,
    ).toBe(false);
  });
});

describe("putting a worker under watch", () => {
  test("the hooks send every tool call, before and after, to the watch for that chat", () => {
    const settings = watchHookSettings(
      { port: 4455, key: "k3y" },
      "imessage:group:any;+;chat5550100",
    ) as {
      hooks: Record<
        string,
        {
          matcher: string;
          hooks: { type: string; url: string; timeout: number; headers: Record<string, string> }[];
        }[]
      >;
    };
    const pre = settings.hooks.PreToolUse![0]!;
    expect(pre.matcher).toBe("*");
    expect(pre.hooks[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:4455/pre/imessage%3Agroup%3Aany%3B%2B%3Bchat5550100",
      headers: { Authorization: "Bearer k3y" },
    });
    expect(settings.hooks.PostToolUse![0]!.hooks[0]!.url).toContain("/post/");
    // Longer than the watch ever holds a call, so the watch decides, not the CLI's timeout.
    expect(pre.hooks[0]!.timeout).toBeGreaterThan(15);
    expect(watchHookSettings(null, "x")).toEqual({});
  });

  test("the watch's hooks sit beside the compaction hook, neither replacing the other", () => {
    const merged = mergeSettings(
      postCompactHookSettings("/usr/local/bin/bun"),
      watchHookSettings({ port: 1, key: "k" }, "s"),
    ) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(merged.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);
    expect(mergeSettings({ a: 1 }, {})).toEqual({ a: 1 });
  });

  test("a worker started while a watch is running gets its hooks; with none running, only the compaction hook", () => {
    expect(readWatchAddress(dataDir)).toBeNull();
    expect(Object.keys((workerSettings(dataDir, "s") as { hooks: object }).hooks)).toEqual([
      "SessionStart",
    ]);
    mkdirSync(join(dataDir, "run"), { recursive: true });
    writeFileSync(join(dataDir, "run", "watch.json"), '{"port":4455,"key":"k3y"}');
    expect(Object.keys((workerSettings(dataDir, "s") as { hooks: object }).hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
    ]);
    expect(
      Object.keys(
        (workerSettings(dataDir, "agent:1", { postCompact: false }) as { hooks: object }).hooks,
      ).sort(),
    ).toEqual(["PostToolUse", "PreToolUse"]);
  });

  test("every place that starts a worker with tools builds its settings from workerSettings", () => {
    // A worker started any other way is a worker nothing is watching.
    const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
    for (const file of ["src/claude/runner.ts", "scripts/agent-runner.ts"]) {
      const code = src(file);
      expect(code).toMatch(/isolatedSettingsArgs\(\s*workerSettings\(/);
      expect(code).not.toContain("ISOLATED_SETTINGS_ARGS");
      expect(code).not.toContain("postCompactHookSettings(");
    }
    // The pooled worker and the spawn-per-turn path both take the runner's argv.
    expect(src("src/claude/worker.ts")).not.toContain("--settings");
  });

  test("a paused chat starts no turn, by the one entry every turn goes through", () => {
    const code = readFileSync(join(import.meta.dir, "..", "src/model/runner.ts"), "utf8");
    const check = code.indexOf("pausedReason(config.paths.data_dir, rawInput.sessionKey)");
    const run = code.indexOf("sessionTransition(rawInput.sessionKey, config, store)", check);
    expect(check).toBeGreaterThan(code.indexOf("export async function runModel("));
    expect(run).toBeGreaterThan(check);
  });
});
