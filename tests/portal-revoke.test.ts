/**
 * Portal links are bearer credentials. Revocation changes what the current
 * link is, per session, and destructive privacy actions need proof of the
 * dialog. Both watched fail against the pre-fix code.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERASE_WORD, privacyConfirmed } from "../src/portal/privacy-confirm.ts";
import {
  b64urlEncode,
  portalGeneration,
  portalToken,
  revokePortalLinks,
  verifyPortalParts,
} from "../src/portal/token.ts";

const secret = Buffer.alloc(32, 7);
const key = "imessage:dm:+15551230001";

describe("portal link revocation", () => {
  test("a fresh session is generation 0 and keeps the original token format", () => {
    const dir = mkdtempSync(join(tmpdir(), "edh-portal-"));
    expect(portalGeneration(dir, key)).toBe(0);
    expect(portalToken(secret, key, 0)).toBe(portalToken(secret, key));
    expect(verifyPortalParts(secret, b64urlEncode(key), portalToken(secret, key), dir)).toBe(key);
  });

  test("revoking bumps the generation, kills the old link, and issues a new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "edh-portal-"));
    const old = portalToken(secret, key);
    expect(revokePortalLinks(dir, key)).toBe(1);
    expect(portalGeneration(dir, key)).toBe(1);
    expect(verifyPortalParts(secret, b64urlEncode(key), old, dir)).toBeNull();
    const current = portalToken(secret, key, 1);
    expect(current).not.toBe(old);
    expect(verifyPortalParts(secret, b64urlEncode(key), current, dir)).toBe(key);
    expect(revokePortalLinks(dir, key)).toBe(2);
    expect(verifyPortalParts(secret, b64urlEncode(key), current, dir)).toBeNull();
    // Other sessions are untouched.
    const other = "imessage:dm:+15551230002";
    expect(verifyPortalParts(secret, b64urlEncode(other), portalToken(secret, other), dir)).toBe(
      other,
    );
    // The file is private and survives a garbage line.
    const file = join(dir, "portal-generations.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))[key]).toBe(2);
  });

  test("a verifier without a data dir only accepts generation 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "edh-portal-"));
    revokePortalLinks(dir, key);
    expect(verifyPortalParts(secret, b64urlEncode(key), portalToken(secret, key, 1))).toBeNull();
  });
});

describe("privacy confirmation", () => {
  test("erase-all needs the typed word, the rest need an explicit flag", () => {
    expect(privacyConfirmed("erase-all", ERASE_WORD)).toBe(true);
    expect(privacyConfirmed("erase-all", ` ${ERASE_WORD} `)).toBe(true);
    expect(privacyConfirmed("erase-all", "erase")).toBe(false);
    expect(privacyConfirmed("erase-all", true)).toBe(false);
    expect(privacyConfirmed("erase-all", undefined)).toBe(false);
    for (const a of ["wipe-media", "wipe-files", "reset-convo"]) {
      expect(privacyConfirmed(a, true)).toBe(true);
      expect(privacyConfirmed(a, "true")).toBe(false);
      expect(privacyConfirmed(a, undefined)).toBe(false);
    }
  });
});
