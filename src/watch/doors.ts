/**
 * What to do about a tunnel or listener that did not come through the
 * publish gate, decided from what it is and whose it is.
 *
 *   the assistant's own, either kind   close it and text the operator
 *   anyone's tunnel                    text the operator, leave it alone
 *   anyone else's listener             put it on the record, if it lasts
 *
 * The last line is what keeps the watch from being switched off. The
 * operator works on this machine, and a dev server made with `Bun.serve`
 * listens on every interface unless told otherwise. It reaches the local
 * network, not the internet. On 2026-11-25 a test that started a listener
 * for a few seconds got the operator a text from the live watch.
 */
import type { Listener, Tunnel } from "../security/watch/exposure.ts";

/**
 * Listeners macOS opens for its own services (AirPlay, Handoff, Screen
 * Sharing). They come and go on ports of their choosing, and are not doors
 * anyone here opened.
 */
const SYSTEM_LISTENERS = new Set([
  "rapportd",
  "ControlCenter",
  "ARDAgent",
  "sharingd",
  "AirPlayXPCHelper",
  "identityservicesd",
  "mDNSResponder",
  "launchd",
  "UniversalControl",
  "remoted",
  "screensharingd",
  "cupsd",
  "sshd",
  "smbd",
]);

export type DoorPolicy =
  | { act: "ignore" }
  | {
      act: "raise";
      tier: "serious" | "notable";
      /** Close it: only ever the assistant's own. */
      close: boolean;
      /** Look again after this long, and raise nothing if it has gone. */
      confirmAfterMs: number;
    };

export function doorPolicy(
  opened: { tunnel?: Tunnel; listener?: Listener },
  facts: { registered: boolean; managed: boolean; assistants: boolean },
): DoorPolicy {
  if (!opened.tunnel && !opened.listener) return { act: "ignore" };
  if (opened.listener && SYSTEM_LISTENERS.has(opened.listener.command)) return { act: "ignore" };
  // Written down at the gate, or a service this checkout installed restarting.
  if (facts.registered || facts.managed) return { act: "ignore" };
  if (facts.assistants) return { act: "raise", tier: "serious", close: true, confirmAfterMs: 0 };
  if (opened.tunnel) return { act: "raise", tier: "serious", close: false, confirmAfterMs: 0 };
  return { act: "raise", tier: "notable", close: false, confirmAfterMs: 20_000 };
}
