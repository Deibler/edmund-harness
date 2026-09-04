import { createHash } from "node:crypto";

const GUID_TTL_MS = 60_000;
const TEXT_TTL_MS = 5_000;
/** Don't walk the maps on every call — at most this often. The TTL windows
 * are seconds-to-a-minute, so a slightly stale entry is harmless; what we
 * care about is not iterating both maps on every inbound on a busy thread. */
const SWEEP_INTERVAL_MS = 5_000;

/**
 * Remember messages *we just sent* so we never process them as inbound.
 *
 * Two keys, two TTLs:
 *  - msgGuid (60s): the message guid we got back from Messages.app, if any
 *  - textHash (5s): fallback for echoes that arrive before our guid is known
 *
 * In-memory only — 5s/60s windows don't need persistence, and losing the
 * cache across restarts is fine (a stale echo will just produce one weird
 * reply, not a loop).
 */
export class EchoCache {
  private byGuid = new Map<string, number>();
  private byText = new Map<string, number>();
  private lastSweep = 0;

  recordSent(text: string, guid?: string): void {
    const now = Date.now();
    if (guid) this.byGuid.set(guid, now);
    this.byText.set(hashText(text), now);
    this.maybeSweep(now);
  }

  isEcho(text: string, guid?: string): boolean {
    const now = Date.now();
    this.maybeSweep(now);
    if (guid) {
      const t = this.byGuid.get(guid);
      if (t !== undefined && now - t <= GUID_TTL_MS) return true;
    }
    const th = this.byText.get(hashText(text));
    if (th !== undefined && now - th <= TEXT_TTL_MS) return true;
    return false;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [k, t] of this.byGuid) if (now - t > GUID_TTL_MS) this.byGuid.delete(k);
    for (const [k, t] of this.byText) if (now - t > TEXT_TTL_MS) this.byText.delete(k);
  }
}

export function hashText(s: string): string {
  return createHash("sha256")
    .update(s.trim().toLowerCase().replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 32);
}
