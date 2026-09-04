import { normalizeHandle } from "../sessions/key.ts";

/**
 * True if the given handle is one of ours (iCloud + phone numbers we listed
 * in config.self.handles). Messages `fromMe` with a self-handle are always
 * dropped — that's us typing on a logged-in Mac.
 */
export function isOwnHandle(handle: string, selfHandles: string[]): boolean {
  if (!handle) return false;
  const n = normalizeHandle(handle);
  return selfHandles.some((s) => normalizeHandle(s) === n);
}
