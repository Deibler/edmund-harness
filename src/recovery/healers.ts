import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evictWarmWorker } from "../claude/runner.ts";
import { REACTIVE_TARGET, compactSession, sessionFilePath } from "../claude/session-compact.ts";
import { repairSessionToolIds } from "../claude/session-repair.ts";
import { relaunchBridge } from "../imessage/bridge/index.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";
import type { FailureClass } from "./classify.ts";

/**
 * Structural fixes the harness can apply to known stuck-session classes
 * before re-invoking the model. Each healer takes the session key + a
 * narrow dep bundle, mutates state idempotently, and reports whether
 * anything actually changed.
 *
 * Healers are pure-effect at the harness level — they never spawn the
 * model. The recovery turn / runner integration drives the "after the
 * heal, re-invoke" step.
 */

type HealerDeps = {
  state: StateStore;
  /** Per-session sandbox path; needed for session JSONL paths. */
  sandboxPath: string;
};

type HealResult = {
  ok: boolean;
  /** True if the healer actually mutated something. */
  changed: boolean;
  /** Free-form note for the daemon log. */
  detail?: string;
};

type Healer = (sessionKey: SessionKey, deps: HealerDeps) => Promise<HealResult>;

export const HEALERS: Record<FailureClass, Healer | null> = {
  request_too_large: healRequestTooLarge,
  image_dim_exceeded: healImageDimExceeded,
  stale_session_id: healStaleSessionId,
  session_in_use: null, // resolved by the session-lock backoff; nothing to heal
  bad_tool_ids: healBadToolIds,
  invalid_tool_schema: null, // static server code — only a code fix + restart helps
  empty_content_block: null, // no structural fix yet; classified for visibility
  transient_api: null, // wait + retry, no structural fix
  send_failed: healSendFailed,
  unknown: null,
};

/**
 * Reactive tool-id repair. The pre-emptive per-resume repair walk was
 * removed from the hot path (it read the full JSONL every turn and had
 * found zero bad ids in production); this healer runs the same rewrite
 * only when the API actually rejects a persisted id — and then evicts
 * the warm worker, because the resident process still holds the broken
 * transcript in memory and would keep resubmitting it.
 */
async function healBadToolIds(sessionKey: SessionKey, deps: HealerDeps): Promise<HealResult> {
  const sess = deps.state.getSession(sessionKey);
  if (!sess?.claudeSessionId) {
    return { ok: false, changed: false, detail: "no claude session id on file" };
  }
  const path = sessionFilePath(deps.sandboxPath, sess.claudeSessionId);
  if (!existsSync(path)) return { ok: false, changed: false, detail: "session file missing" };
  const repaired = repairSessionToolIds(path);
  const evicted = await evictWarmWorker(sessionKey, "bad_tool_ids heal");
  log.info("heal", "bad_tool_ids", {
    session: sessionKey,
    tool_uses: repaired.toolUseIds,
    tool_results: repaired.toolResultIds,
    evicted_worker: evicted,
  });
  return {
    ok: repaired.changed || evicted,
    changed: repaired.changed || evicted,
    detail: `repaired ${repaired.toolUseIds}+${repaired.toolResultIds} ids; worker ${evicted ? "evicted" : "not resident"}`,
  };
}

/**
 * Recover from a wedged Messages bridge.
 *
 * The supervisor owns this: it verifies Messages actually went away before
 * relaunching, and waits for the handshake rather than trusting an exit code.
 * The old healer shelled out to `imsg launch`, which returned success without
 * relaunching anything whenever Messages was already running with the dylib
 * mapped — so the heal reported itself fixed while the bridge stayed dead.
 *
 * Session-independent: one bridge serves every chat, so one relaunch unsticks
 * all of them.
 */
async function healSendFailed(sessionKey: SessionKey, _deps: HealerDeps): Promise<HealResult> {
  try {
    await relaunchBridge(`send failed for ${sessionKey}`);
  } catch (err) {
    return {
      ok: false,
      changed: false,
      detail: `relaunch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  log.info("heal", "send_failed", { session: sessionKey, detail: "Messages bridge relaunched" });
  return { ok: true, changed: true, detail: "relaunched Messages and the bridge handshook" };
}

async function healRequestTooLarge(sessionKey: SessionKey, deps: HealerDeps): Promise<HealResult> {
  const sess = deps.state.getSession(sessionKey);
  if (!sess?.claudeSessionId) {
    return { ok: false, changed: false, detail: "no claude session id on file" };
  }
  const path = sessionFilePath(deps.sandboxPath, sess.claudeSessionId);
  const result = compactSession(path, REACTIVE_TARGET);
  log.info("heal", "request_too_large", {
    session: sessionKey,
    before: result.beforeBytes,
    after: result.afterBytes,
    images_compacted: result.imagesCompacted,
    total_images: result.totalImages,
  });
  return {
    ok: result.changed || result.beforeBytes <= REACTIVE_TARGET,
    changed: result.changed,
    detail: `${result.beforeBytes} → ${result.afterBytes} bytes (${result.imagesCompacted} images elided)`,
  };
}

async function healStaleSessionId(sessionKey: SessionKey, deps: HealerDeps): Promise<HealResult> {
  const sess = deps.state.getSession(sessionKey);
  if (!sess?.claudeSessionId) {
    return { ok: true, changed: false, detail: "already cold" };
  }
  deps.state.setClaudeSessionId(sessionKey, null);
  log.info("heal", "stale_session_id", { session: sessionKey, dropped: sess.claudeSessionId });
  return { ok: true, changed: true, detail: `dropped ${sess.claudeSessionId}` };
}

/**
 * Walk the session JSONL, find any base64 image whose decoded dimensions
 * exceed 2000 px on either axis, downscale in place via `sips`. Mirrors
 * `compactSession`'s atomic-write contract. Sips is preinstalled on every
 * Mac the harness runs on.
 */
async function healImageDimExceeded(sessionKey: SessionKey, deps: HealerDeps): Promise<HealResult> {
  const sess = deps.state.getSession(sessionKey);
  if (!sess?.claudeSessionId) {
    return { ok: false, changed: false, detail: "no claude session id on file" };
  }
  const path = sessionFilePath(deps.sandboxPath, sess.claudeSessionId);
  if (!existsSync(path)) return { ok: false, changed: false, detail: "session file missing" };

  // Hard cap on session JSONL size. A corrupt or runaway-large file
  // (e.g. a stuck tool-call loop that dumped megabytes of base64)
  // could otherwise block the heal forever loading into memory.
  // 256 MiB is ~5x the largest healthy session we've ever seen.
  const SESSION_JSONL_MAX_BYTES = 256 * 1024 * 1024;
  const fileBytes = statSync(path).size;
  if (fileBytes > SESSION_JSONL_MAX_BYTES) {
    log.warn("heal", "session JSONL exceeds max size; skipping heal", {
      session: sessionKey,
      bytes: fileBytes,
      limit: SESSION_JSONL_MAX_BYTES,
    });
    return {
      ok: false,
      changed: false,
      detail: `session file ${fileBytes}b > ${SESSION_JSONL_MAX_BYTES}b limit`,
    };
  }

  const lines = readFileSync(path, "utf8").split("\n");
  let touched = 0;
  let scanned = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const changed = walkAndShrinkImages(
      rec,
      (replaced) => {
        touched += replaced;
      },
      (scannedDelta) => {
        scanned += scannedDelta;
      },
    );
    if (changed) lines[i] = JSON.stringify(rec);
  }

  if (touched === 0) {
    return { ok: true, changed: false, detail: `${scanned} images scanned, none oversized` };
  }

  const mode = statSync(path).mode & 0o777;
  const tmpPath = `${path}.healimg.tmp`;
  writeFileSync(tmpPath, lines.join("\n"));
  const { renameSync, chmodSync } = require("node:fs") as typeof import("node:fs");
  renameSync(tmpPath, path);
  if (mode) chmodSync(path, mode);

  log.info("heal", "image_dim_exceeded", { session: sessionKey, downscaled: touched, scanned });
  return { ok: true, changed: true, detail: `downscaled ${touched}/${scanned} images` };
}

/**
 * Walk a record's content blocks. For each base64 image whose decoded
 * dimensions exceed 2000 px, downscale via sips and re-encode as JPEG.
 * Mutates the record in place. Returns true if anything changed.
 */
function walkAndShrinkImages(
  rec: unknown,
  onReplace: (n: number) => void,
  onScan: (n: number) => void,
): boolean {
  let mutated = false;
  const stack: Array<{ node: unknown; parent: unknown; key: string | number | null }> = [
    { node: rec, parent: null, key: null },
  ];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const { node, parent, key } = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (isBase64Image(node)) {
      onScan(1);
      const shrunk = shrinkIfOversized(node);
      if (shrunk) {
        const placeholder = {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: shrunk,
          },
        };
        if (Array.isArray(parent)) (parent as unknown[])[key as number] = placeholder;
        else (parent as Record<string, unknown>)[key as string] = placeholder;
        onReplace(1);
        mutated = true;
      }
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push({ node: node[i], parent: node, key: i });
      }
    } else {
      for (const [k, v] of Object.entries(node)) {
        stack.push({ node: v, parent: node, key: k });
      }
    }
  }
  return mutated;
}

type Base64ImageBlock = {
  type: "image";
  source: { type: "base64"; data: string; media_type?: string };
};

function isBase64Image(b: unknown): b is Base64ImageBlock {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  if (o.type !== "image") return false;
  const src = o.source as Record<string, unknown> | undefined;
  return !!src && src.type === "base64" && typeof src.data === "string";
}

const MAX_DIM = 2000;

/**
 * If the image's longest side exceeds MAX_DIM, run it through sips to
 * downscale + re-encode as JPEG; return the new base64. Otherwise return
 * null (caller leaves the block alone). Failures return null and log —
 * we don't want a flaky sips call to blow away the block.
 */
function shrinkIfOversized(block: Base64ImageBlock): string | null {
  const tmpBase = join(
    tmpdir(),
    `edmund-heal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const srcPath = `${tmpBase}.bin`;
  const outPath = `${tmpBase}.jpg`;
  try {
    writeFileSync(srcPath, Buffer.from(block.source.data, "base64"));
    const dims = readDimsViaSips(srcPath);
    if (!dims) return null;
    if (dims.width <= MAX_DIM && dims.height <= MAX_DIM) return null;
    const res = spawnSync(
      "sips",
      ["-Z", String(MAX_DIM), "-s", "format", "jpeg", srcPath, "--out", outPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (res.status !== 0) {
      log.warn("heal", "sips downscale failed", {
        stderr: String(res.stderr ?? "").slice(0, 200),
      });
      return null;
    }
    if (!existsSync(outPath)) return null;
    return readFileSync(outPath).toString("base64");
  } catch (err) {
    log.warn("heal", "shrink failed", { err: (err as Error).message });
    return null;
  } finally {
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    for (const p of [srcPath, outPath]) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
}

function readDimsViaSips(path: string): { width: number; height: number } | null {
  const res = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return null;
  const out = String(res.stdout ?? "");
  const w = out.match(/pixelWidth:\s*(\d+)/);
  const h = out.match(/pixelHeight:\s*(\d+)/);
  if (!w || !h) return null;
  return { width: Number(w[1]), height: Number(h[1]) };
}
