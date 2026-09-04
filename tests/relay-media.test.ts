/**
 * Unit test for the cross-session media staging path used by the relay.
 * Spawns a temp source file, asks `stageRelayMedia` to copy it into a fake
 * recipient sandbox, asserts the dest exists and image classification is
 * correct.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRelayMedia } from "../src/bridge/relay-media.ts";

describe("stageRelayMedia", () => {
  test("copies image + non-image into recipient sandbox and classifies images", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-media-"));
    const png = join(tmp, "photo.png");
    const pdf = join(tmp, "report.pdf");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    writeFileSync(pdf, Buffer.from("%PDF-1.4\n", "utf8"));

    // ensureSandbox writes under process.cwd()/sandbox/<slug>; use a unique
    // session key per run so we don't trample real sandboxes when tests run
    // in the repo root.
    const sessionKey = `imessage:dm:+19995550${String(Date.now()).slice(-3)}` as const;

    const result = stageRelayMedia({
      mediaPaths: [png, pdf],
      targetSessionKey: sessionKey,
      originatorDisplayName: "Jordan Carter",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staged.paths.length).toBe(2);
    expect(result.staged.imagePaths.length).toBe(1);
    // Image classified correctly.
    expect(result.staged.imagePaths[0]).toMatch(/\.png$/);
    // Both files actually copied.
    for (const p of result.staged.paths) {
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
    }
    // Recipient-side directory uses originator slug.
    expect(result.staged.paths[0]).toContain("received-from-jordan-carter");
    // Originals untouched.
    expect(readFileSync(png).length).toBe(4);
  });

  test("rejects missing file with a clear error", () => {
    const sessionKey = "imessage:dm:+19995559999" as const;
    const result = stageRelayMedia({
      mediaPaths: ["/tmp/definitely-not-here-9981273.dat"],
      targetSessionKey: sessionKey,
      originatorDisplayName: "Tester",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("file not found");
  });

  test("rejects non-absolute paths", () => {
    const sessionKey = "imessage:dm:+19995559998" as const;
    const result = stageRelayMedia({
      mediaPaths: ["relative/path.png"],
      targetSessionKey: sessionKey,
      originatorDisplayName: "Tester",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/absolute|file not found/);
  });
});
