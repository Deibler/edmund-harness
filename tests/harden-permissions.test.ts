import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenHarnessPermissions, hardenPaths } from "../src/boot/harden-permissions.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("permission hardening", () => {
  test("directories go to 0700 and sensitive files to 0600, media is left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "edh-harden-"));
    const data = join(root, "data");
    mkdirSync(data);
    chmodSync(data, 0o755);
    for (const f of [
      "state.db",
      "state.db-wal",
      "daemon.log",
      "dashboard.secret",
      "sms-tunnel-token",
      "pool-stats.json",
    ]) {
      writeFileSync(join(data, f), "x");
      chmodSync(join(data, f), 0o644);
    }
    writeFileSync(join(data, "photo.png"), "x");
    chmodSync(join(data, "photo.png"), 0o644);
    writeFileSync(join(root, "config.toml"), "x");
    chmodSync(join(root, "config.toml"), 0o644);
    writeFileSync(join(root, "config.toml.bak-123"), "x");
    chmodSync(join(root, "config.toml.bak-123"), 0o644);

    const report = hardenHarnessPermissions(root, data);
    expect(report.errors).toEqual([]);
    expect(mode(data)).toBe(0o700);
    for (const f of [
      "state.db",
      "state.db-wal",
      "daemon.log",
      "dashboard.secret",
      "sms-tunnel-token",
      "pool-stats.json",
    ]) {
      expect(mode(join(data, f))).toBe(0o600);
    }
    expect(mode(join(data, "photo.png"))).toBe(0o644);
    expect(mode(join(root, "config.toml"))).toBe(0o600);
    expect(mode(join(root, "config.toml.bak-123"))).toBe(0o600);
  });

  test("missing paths are skipped, not errors", () => {
    const report = hardenPaths(["/nonexistent/edh-x"], ["/nonexistent/edh-y"]);
    expect(report).toEqual({ dirs: 0, files: 0, errors: [] });
  });
});
