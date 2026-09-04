import { copyFileSync, existsSync, statSync } from "node:fs";
import type { InboundMessage } from "../imessage/types.ts";
import { receivedPath } from "./media-paths.ts";

/**
 * How long to wait for a freshly-arrived attachment to finish writing to disk.
 * iMessage inserts the chat.db row as soon as the message lands, but the
 * attachment file (especially videos downloaded from APN/iCloud) can still be
 * streaming when the watcher fires. Without this wait, copyAttachments would
 * silently skip the path and the model would see a stale/empty reference.
 *
 * Two regimes:
 *  - "Apple staging path" (under `/var/folders/.../TemporaryItems/`): iMessage
 *    is mid-stage, may take a while for iCloud-backed HEICs. Generous window.
 *  - Normal `~/Library/Messages/Attachments/...`: file is usually already on
 *    disk by the time the chat.db row appears; short window is enough.
 */
const WAIT_TIMEOUT_STAGING_MS = 60_000;
const WAIT_TIMEOUT_NORMAL_MS = 30_000;
const WAIT_POLL_MS = 400;

function waitWindowFor(path: string): number {
  return path.includes("/com.apple.imagent/TemporaryItems/") ||
    (path.includes("/var/folders/") && path.includes("/TemporaryItems/"))
    ? WAIT_TIMEOUT_STAGING_MS
    : WAIT_TIMEOUT_NORMAL_MS;
}

/**
 * Copy arbitrary attachment paths (from any message, past or present) into
 * the sandbox's received-* buckets. Used for both current batches and for
 * parent-of-reply messages so the model can read images threaded behind a
 * reply.
 *
 * Historical variant: does not wait for files. Use copyReceivedAttachments
 * when the batch just arrived and videos may still be downloading.
 */
export function copyAttachments(
  sandboxPath: string,
  attachments: string[],
  messageDate: Date,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const src of attachments) {
    if (!existsSync(src)) continue;
    const dest = receivedPath(sandboxPath, src, messageDate);
    if (!existsSync(dest)) {
      try {
        copyFileSync(src, dest);
      } catch (err) {
        console.warn(`[copy-received] failed for ${src}: ${(err as Error).message}`);
        continue;
      }
    }
    map.set(src, dest);
  }
  return map;
}

export type CopyReceivedResult = {
  /** source path → stable sandbox copy. */
  copied: Map<string, string>;
  /** source paths that timed out or failed; the model should NOT see these as
   *  real attachments — they're "still uploading from iMessage." */
  pending: string[];
};

/**
 * Snapshot every inbound attachment into the session sandbox's received-*
 * buckets so the conversation has a self-contained record. Messages.app
 * sometimes prunes its own attachment store, so keeping a local copy means
 * the model can re-inspect files weeks later.
 *
 * Unlike copyAttachments, this version waits for each source path to finish
 * writing. iMessage writes the chat.db row before the attachment body is on
 * disk — most visible with videos and iCloud-staged HEICs, which can take
 * a while.
 *
 * Returns both the successful copies AND the pending (timed-out) source
 * paths. Callers should strip the pending paths from `msg.attachments`
 * before envelope build so the model never sees a dead `/var/folders/...`
 * temp reference, and instead gets a clear "Pending attachments: N"
 * marker from the envelope builder.
 */
export async function copyReceivedAttachments(
  sandboxPath: string,
  batch: InboundMessage[],
  // `waitTimeoutMs` overrides the per-path stability window (mainly for
  // tests, which don't want to sit through the real 30s/60s timeouts).
  opts?: { waitTimeoutMs?: number },
): Promise<CopyReceivedResult> {
  const copied = new Map<string, string>();
  const pending: string[] = [];
  const windowFor = (src: string) => opts?.waitTimeoutMs ?? waitWindowFor(src);

  // Collect unique source paths first. A path can appear twice in a batch
  // (the same image quoted and re-sent); wait for it once. The earliest
  // message that carries it owns the received-bucket date.
  const order: string[] = [];
  const dateForSrc = new Map<string, Date>();
  for (const msg of batch) {
    if (msg.attachments.length === 0) continue;
    const messageDate = new Date(msg.timestampMs);
    for (const src of msg.attachments) {
      if (!dateForSrc.has(src)) {
        dateForSrc.set(src, messageDate);
        order.push(src);
      }
    }
  }
  if (order.length === 0) return { copied, pending };

  // Wait for all of them in parallel — iMessage may still be streaming a
  // video while the chat.db row is already visible, and serial waits would
  // hold the session lock for the *sum* of the timeouts instead of the max.
  const ready = await Promise.all(order.map((src) => waitForStableFile(src, windowFor(src))));

  for (let i = 0; i < order.length; i++) {
    const src = order[i]!;
    if (!ready[i]) {
      console.warn(
        `[copy-received] ${src} never materialized after ${windowFor(src)}ms — skipping`,
      );
      pending.push(src);
      continue;
    }
    const dest = receivedPath(sandboxPath, src, dateForSrc.get(src)!);
    if (!existsSync(dest)) {
      try {
        copyFileSync(src, dest);
      } catch (err) {
        console.warn(`[copy-received] failed for ${src}: ${(err as Error).message}`);
        pending.push(src);
        continue;
      }
    }
    copied.set(src, dest);
  }
  return { copied, pending };
}

/**
 * Poll until `path` exists and its size has been stable for one poll cycle.
 * Size-stability catches the in-progress-write case: a file that just
 * appeared may still be growing; copying mid-write would truncate it.
 * Returns true on success, false if the deadline elapsed without the file
 * stabilizing.
 */
async function waitForStableFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let announced = false;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const size = statSync(path).size;
        if (size > 0 && size === lastSize) return true;
        lastSize = size;
      } catch {
        // stat raced with a rename/replace; retry
      }
    } else if (!announced) {
      console.log(`[copy-received] waiting for ${path}`);
      announced = true;
    }
    await sleep(WAIT_POLL_MS);
  }
  return existsSync(path) && statSync(path).size > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
