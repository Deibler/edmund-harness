/**
 * bun test preload (wired via bunfig.toml). Redirects sandbox writes to a
 * temp dir so unit tests never pollute the real sandbox/ tree — ghost
 * tests once wrote 543 fake decision rows into production telemetry.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EDMUND_SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "edmund-test-sandbox-"));
