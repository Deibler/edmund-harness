import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSchedule } from "../dashboard/server/routes/portal.ts";
import {
  listSessionFiles,
  resolveSessionFile,
  wipeFiles,
  wipeMedia,
} from "../dashboard/server/services/portalData.ts";
import { CronStore } from "../src/cron/store.ts";
import { sandboxDir } from "../src/persona/sandbox.ts";
import { b64urlEncode, portalPath, portalToken, verifyPortalParts } from "../src/portal/token.ts";

const SECRET = randomBytes(32);

describe("portal tokens", () => {
  test("round-trip: path parts verify back to the session key", () => {
    const key = "imessage:dm:+15550100003";
    const path = portalPath(SECRET, key);
    const [, , enc, token] = path.split("/");
    expect(verifyPortalParts(SECRET, enc!, token!)).toBe(key);
  });

  test("tampered token fails", () => {
    const key = "imessage:dm:+15550100003";
    const enc = b64urlEncode(key);
    const token = portalToken(SECRET, key);
    const bad = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyPortalParts(SECRET, enc, bad)).toBeNull();
  });

  test("token for one session cannot control another", () => {
    const token = portalToken(SECRET, "imessage:dm:+1111");
    expect(verifyPortalParts(SECRET, b64urlEncode("imessage:dm:+2222"), token)).toBeNull();
  });

  test("different secrets produce different tokens", () => {
    const other = randomBytes(32);
    expect(portalToken(SECRET, "k")).not.toBe(portalToken(other, "k"));
  });
});

describe("cron pause/resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-cron-"));

  test("paused jobs are skipped by nextDue and resume reschedules", () => {
    const crons = new CronStore(dir);
    const job = crons.create({
      sessionKey: "imessage:dm:+1555",
      systemEvent: "reminder: water the plants",
      schedule: { kind: "once", atMs: Date.now() - 60_000 }, // already due
    });
    expect(crons.nextDue()?.id).toBe(job.id);

    expect(crons.pause(job.id)).toBe(true);
    expect(crons.nextDue()).toBeNull();
    expect(crons.get(job.id)?.status).toBe("paused");
    expect(crons.listForPortal("imessage:dm:+1555")).toHaveLength(1);

    expect(crons.resume(job.id)).toBe(true);
    const resumed = crons.get(job.id);
    expect(resumed?.status).toBe("active");
    // overdue once-job fires shortly after resume, not in the past
    expect(resumed!.nextFireMs).toBeGreaterThan(Date.now());

    // double-pause / double-resume are no-ops
    expect(crons.resume(job.id)).toBe(false);
    crons.close();
  });
});

describe("portal schedule builder", () => {
  test("once requires a future timestamp", () => {
    expect(buildSchedule({ freq: "once", atMs: Date.now() + 3_600_000 })).toEqual({
      kind: "once",
      atMs: expect.any(Number),
    });
    expect(buildSchedule({ freq: "once", atMs: Date.now() - 3_600_000 })).toBeNull();
    expect(buildSchedule({ freq: "once" })).toBeNull();
    // and not absurdly far out
    expect(buildSchedule({ freq: "once", atMs: Date.now() + 400 * 86_400_000 })).toBeNull();
  });

  test("hourly / daily / weekly map to cron exprs", () => {
    expect(buildSchedule({ freq: "hourly" })).toEqual({ kind: "cron", expr: "0 * * * *" });
    expect(buildSchedule({ freq: "daily", time: "07:30" })).toEqual({
      kind: "cron",
      expr: "30 7 * * *",
    });
    expect(buildSchedule({ freq: "weekly", time: "18:00", dow: "fri" })).toEqual({
      kind: "cron",
      expr: "0 18 * * 5",
    });
    expect(buildSchedule({ freq: "weekly", time: "18:00", dow: "someday" })).toBeNull();
    expect(buildSchedule({ freq: "daily", time: "25:00" })).toBeNull();
    expect(buildSchedule({ freq: "daily" })).toBeNull();
    expect(buildSchedule({ freq: "constantly" })).toBeNull();
  });
});

describe("portal sandbox file access", () => {
  // tests/_setup.ts points EDMUND_SANDBOX_ROOT at a tmpdir, so sandboxDir()
  // resolves inside it — safe to create/destroy freely here.
  const KEY = "imessage:dm:+19995550042";
  const root = sandboxDir(KEY);

  test("listSessionFiles excludes media dirs and ghost telemetry", () => {
    mkdirSync(join(root, "images"), { recursive: true });
    mkdirSync(join(root, "brownnose", "drafts"), { recursive: true });
    mkdirSync(join(root, "project"), { recursive: true });
    mkdirSync(join(root, "project", "venv", "lib", "site-packages", "pkg"), {
      recursive: true,
    });
    mkdirSync(join(root, "project", "cadlib", "vendor"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hi");
    writeFileSync(join(root, "images", "photo.png"), "png");
    writeFileSync(join(root, "brownnose", "decisions.jsonl"), "{}");
    writeFileSync(join(root, "brownnose", "drafts", "plan.md"), "# plan");
    writeFileSync(join(root, "project", "report.pdf"), "%PDF");
    writeFileSync(
      join(root, "project", "venv", "lib", "site-packages", "pkg", "internal.py"),
      "pass",
    );
    writeFileSync(join(root, "project", "cadlib", "vendor", "internal.py"), "pass");

    const files = listSessionFiles(KEY);
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toEqual(["README.md", "brownnose/drafts/plan.md", "project/report.pdf"]);
    expect(files.find((f) => f.relPath === "project/report.pdf")?.isArtifact).toBe(true);
  });

  test("resolveSessionFile refuses traversal and symlink escapes", () => {
    // realpath-normalized compare (macOS /var → /private/var)
    expect(resolveSessionFile(KEY, "README.md")?.endsWith("/dm_19995550042/README.md")).toBe(true);
    expect(resolveSessionFile(KEY, "../other/secret.txt")).toBeNull();
    expect(resolveSessionFile(KEY, "/etc/passwd")).toBeNull();
    expect(resolveSessionFile(KEY, "")).toBeNull();
    expect(resolveSessionFile(KEY, "missing.md")).toBeNull();
    // a directory is not servable
    expect(resolveSessionFile(KEY, "project")).toBeNull();
    // symlink pointing outside the sandbox
    const outside = mkdtempSync(join(tmpdir(), "portal-out-"));
    writeFileSync(join(outside, "leak.txt"), "secret");
    symlinkSync(join(outside, "leak.txt"), join(root, "leak-link.txt"));
    expect(resolveSessionFile(KEY, "leak-link.txt")).toBeNull();
  });

  test("wipeMedia removes media dirs only; wipeFiles removes the rest", () => {
    expect(listSessionFiles(KEY).length).toBeGreaterThan(0);
    const media = wipeMedia(KEY);
    expect(media.removed).toBe(1); // images/photo.png
    expect(listSessionFiles(KEY).length).toBeGreaterThan(0); // files untouched

    const files = wipeFiles(KEY);
    expect(files.removed).toBeGreaterThan(0);
    expect(listSessionFiles(KEY)).toHaveLength(0);
  });
});
