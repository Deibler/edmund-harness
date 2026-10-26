import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingStorage } from "../src/boot/storage.ts";
import { encodeProjectDir, ensureSessionLink } from "../src/claude/session-store.ts";

let base: string;
let repo: string;
let disk: string;
let home: string;
let sessions: string;

beforeEach(() => {
  // Resolved first: macOS's tmpdir sits behind the /var -> /private/var link.
  base = realpathSync(mkdtempSync(join(tmpdir(), "edmund-session-link-")));
  repo = join(base, "repo");
  disk = join(base, "disk");
  home = join(base, "home", "projects");
  sessions = join(repo, "persona", "sessions");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(disk, "sandbox", "dm_1"), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("ensureSessionLink", () => {
  test("a sandbox on the repo's own disk gets one link", () => {
    const cwd = join(repo, "sandbox", "dm_1");
    mkdirSync(cwd, { recursive: true });
    ensureSessionLink(cwd, sessions, home);
    const link = join(home, encodeProjectDir(cwd));
    expect(readlinkSync(link)).toBe(join(sessions, encodeProjectDir(cwd)));
  });

  test("a sandbox behind a symlink is reachable by both names", () => {
    symlinkSync(join(disk, "sandbox"), join(repo, "sandbox"));
    const cwd = join(repo, "sandbox", "dm_1");
    ensureSessionLink(cwd, sessions, home);
    const target = join(sessions, encodeProjectDir(cwd));
    const resolvedName = encodeProjectDir(join(disk, "sandbox", "dm_1"));
    expect(resolvedName).not.toBe(encodeProjectDir(cwd));
    expect(readlinkSync(join(home, encodeProjectDir(cwd)))).toBe(target);
    expect(readlinkSync(join(home, resolvedName))).toBe(target);
    // What Claude Code writes under the resolved name is the transcript the
    // harness reads under the logical one.
    writeFileSync(join(home, resolvedName, "s1.jsonl"), "{}\n");
    expect(readFileSync(join(target, "s1.jsonl"), "utf8")).toBe("{}\n");
  });

  test("a folder Claude already made under the resolved name is folded in", () => {
    symlinkSync(join(disk, "sandbox"), join(repo, "sandbox"));
    const cwd = join(repo, "sandbox", "dm_1");
    const resolvedName = encodeProjectDir(join(disk, "sandbox", "dm_1"));
    mkdirSync(join(home, resolvedName), { recursive: true });
    writeFileSync(join(home, resolvedName, "early.jsonl"), "x\n");
    ensureSessionLink(cwd, sessions, home);
    expect(lstatSync(join(home, resolvedName)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(sessions, encodeProjectDir(cwd), "early.jsonl"))).toBe(true);
  });
});

describe("missingStorage", () => {
  test("plain folders and mounted links pass", () => {
    mkdirSync(join(repo, "persona", "sessions"), { recursive: true });
    symlinkSync(join(disk, "sandbox"), join(repo, "sandbox"));
    expect(missingStorage(repo)).toEqual([]);
  });

  test("a link to a disk that is not mounted stops the boot", () => {
    mkdirSync(join(repo, "persona"), { recursive: true });
    symlinkSync(join(base, "unmounted", "sandbox"), join(repo, "sandbox"));
    symlinkSync(join(base, "unmounted", "sessions"), join(repo, "persona", "sessions"));
    expect(missingStorage(repo)).toEqual([
      `sandbox -> ${join(base, "unmounted", "sandbox")}`,
      `persona/sessions -> ${join(base, "unmounted", "sessions")}`,
    ]);
  });

  test("nothing there yet is not missing", () => {
    expect(missingStorage(repo)).toEqual([]);
  });
});
