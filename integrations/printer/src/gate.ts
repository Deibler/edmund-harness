import type { Decision } from "./approval.ts";
import { SAME_COLOR, colorDistance, colorName } from "./color.ts";
import type { Plan } from "./filament.ts";
import type { HmsEntry, PrinterState } from "./report.ts";
import { isIdle } from "./report.ts";
import type { Approval, Job } from "./store.ts";

/**
 * Everything that must be true before Edmund may start a print, as one pure
 * function so each condition can be tested by breaking it.
 *
 * The rules, from the person who owns the printer: a print starts only after
 * the approver says yes to that print, only from the conversation that asked
 * for it, only with the colors they approved loaded where the plan put them,
 * and only after Edmund has looked at the plate himself and an independent
 * look agrees it is empty. Every reason it may not start is returned, not
 * just the first, so one round trip fixes them all.
 */

export type PlateLook = { verdict: "CLEAR" | "OCCUPIED" | "UNSURE"; frameMs: number; note: string };

/** How a start or cancel reaches the printer. */
export type SendRoute = "lan" | "bambu_connect";
export type SendVia = "auto" | SendRoute;

/**
 * The route for a print command. Bambu's firmware takes start and stop over
 * the LAN only in Developer Mode (which on the P2S means LAN Only Mode, and no
 * Bambu Handy); otherwise they must come from Bambu's own signed software,
 * which is what Bambu Connect is. "auto" prefers the LAN when it is open.
 */
export function chooseRoute(
  via: SendVia,
  developerMode: boolean | null,
  connectReady: boolean,
): { route: SendRoute | null; problem: string } {
  const noConnect =
    "Bambu Connect is not installed on the Mac (brew install --cask bambu-connect, then sign in to the Bambu account in it once).";
  const noDev = "The printer is not in Developer Mode, so it will not take this over the LAN.";
  if (via === "lan") {
    return developerMode === false
      ? { route: null, problem: noDev }
      : { route: "lan", problem: "" };
  }
  if (via === "bambu_connect") {
    return connectReady
      ? { route: "bambu_connect", problem: "" }
      : { route: null, problem: noConnect };
  }
  if (developerMode === true) return { route: "lan", problem: "" };
  if (connectReady) return { route: "bambu_connect", problem: "" };
  if (developerMode === null) return { route: "lan", problem: "" };
  return {
    route: null,
    problem:
      "The printer is not in Developer Mode and Bambu Connect is not installed, so nothing can send it a print. Installing Bambu Connect keeps Bambu Handy working; the other way is LAN Only Mode plus Developer Mode on the printer.",
  };
}

export type GateInput = {
  now: number;
  callerSession: string;
  job: Job;
  approval: Approval | null;
  /** Re-read from chat.db for this check; never taken from the store's word alone. */
  decision: Decision | null;
  approvers: string[];
  ttlMs: number;
  state: PrinterState | null;
  stateAgeMs: number;
  /** The plan computed from the trays loaded right now. */
  plan: Plan;
  /** The frame Edmund looked at, by its capture time. */
  ownLookMs: number | null;
  /** The independent check of a fresh frame. */
  plateLook: PlateLook | null;
  /** [printer].send_via, and whether Bambu Connect is installed. */
  sendVia: SendVia;
  connectReady: boolean;
  /** The approver's answer to a photo of the plate, when the plate check was unsure. */
  plateConfirm: { approval: Approval; decision: Decision | null } | null;
};

const PLATE_LOOK_MAX_AGE_MS = 5 * 60_000;
/** How long the approver's "the plate is clear" stands; someone could put something on it after. */
export const PLATE_CONFIRM_MAX_AGE_MS = 15 * 60_000;
const STATE_MAX_AGE_MS = 90_000;

/** HMS severities that mean the printer should not be asked to print. */
export function blockingHms(hms: HmsEntry[]): HmsEntry[] {
  return hms.filter((h) => {
    const sev = h.code >>> 16;
    return sev === 1 || sev === 2;
  });
}

/** For each need, the tray the approved plan sends it to: an existing match, or the slot a swap fills. */
export function approvedSlots(plan: Plan): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of plan.assignments) m.set(a.need.index, a.tray.trayId);
  for (const s of plan.swaps) m.set(s.need.index, s.slot.trayId);
  return m;
}

/**
 * Whether the approver has confirmed, from a photo, that the plate is clear
 * for this print: asked from the print's own conversation after the yes to
 * print it, with a photo taken after that yes, answered yes by an approver
 * after the ask, and recently. "none" when nobody was asked.
 */
export function plateConfirmation(g: {
  now: number;
  job: Job;
  /** When the approver said yes to the print. */
  printYesMs: number | null;
  plateConfirm: GateInput["plateConfirm"];
  approvers: string[];
}): { state: "none" | "valid" | "waiting" | "invalid"; problem: string } {
  const c = g.plateConfirm;
  if (!c || c.approval.action !== "plate" || c.approval.jobId !== g.job.id)
    return { state: "none", problem: "" };
  const a = c.approval;
  const d = c.decision;
  if (!["pending", "approved"].includes(a.status)) return { state: "none", problem: "" };
  if (a.sessionKey !== g.job.originSession)
    return {
      state: "invalid",
      problem: "The plate confirmation was asked from another conversation.",
    };
  if (g.printYesMs === null || a.askedMs <= g.printYesMs || (a.frameMs ?? 0) < g.printYesMs)
    return {
      state: "invalid",
      problem:
        "The plate confirmation must be asked after the yes to this print, with a photo taken after it.",
    };
  if (!d)
    return {
      state: "waiting",
      problem: "Waiting for the approver to confirm the plate from the photo.",
    };
  if (d.verdict !== "approve")
    return {
      state: "invalid",
      problem: `The approver says the plate is not clear ("${d.text}"). Ask for it to be cleared, then look again.`,
    };
  if (!g.approvers.includes(d.by))
    return { state: "invalid", problem: "The plate confirmation did not come from an approver." };
  if (d.ms <= a.askedMs)
    return { state: "invalid", problem: "The plate confirmation came before the ask." };
  if (g.now - d.ms > PLATE_CONFIRM_MAX_AGE_MS)
    return {
      state: "invalid",
      problem:
        "The plate confirmation is more than 15 minutes old; take a new photo and ask again.",
    };
  return { state: "valid", problem: "" };
}

export function checkStartGate(g: GateInput): {
  ok: boolean;
  problems: string[];
  route: SendRoute | null;
} {
  const p: string[] = [];
  let route: SendRoute | null = null;
  const { job } = g;

  if (g.callerSession !== job.originSession) {
    p.push(
      "This print belongs to another conversation. Only the conversation that asked for it may start it; that conversation has been told about the yes.",
    );
  }
  if (!["approved", "awaiting_approval"].includes(job.status)) {
    p.push(`The job is ${job.status.replace("_", " ")}, not approved.`);
  }

  // The yes.
  if (!g.approval || g.approval.action !== "start" || g.approval.jobId !== job.id) {
    p.push("Nobody has been asked to approve this print yet. Use print_request_approval.");
  } else if (!["pending", "approved"].includes(g.approval.status)) {
    p.push(`The approval is ${g.approval.status}. Ask again with print_request_approval.`);
  } else if (!g.decision) {
    p.push(
      "No yes from the approver in the chat yet. Wait for one; do not start on anything else.",
    );
  } else {
    const d = g.decision;
    if (d.verdict !== "approve") p.push(`The approver said no ("${d.text}").`);
    if (!g.approvers.includes(d.by)) p.push("The yes did not come from an approver.");
    if (d.ms <= g.approval.askedMs)
      p.push("The yes came before the ask, so it is not a yes to this print.");
    if (g.now - d.ms > g.ttlMs) {
      p.push("The yes is too old to start a print on now. Ask again with print_request_approval.");
    }
  }

  // The printer.
  const st = g.state;
  if (!st || g.stateAgeMs > STATE_MAX_AGE_MS) {
    p.push("No current status from the printer, so it cannot be checked. Try again in a minute.");
  } else {
    if (!isIdle(st)) p.push(`The printer is ${st.stateLabel}, not ready for a new print.`);
    const r = chooseRoute(g.sendVia, st.developerMode, g.connectReady);
    route = r.route;
    if (!r.route) p.push(r.problem);
    const blocking = blockingHms(st.hms);
    if (blocking.length)
      p.push(`The printer is reporting ${blocking.length} serious error(s); clear them first.`);
  }

  // The colors.
  if (!g.plan.ok) {
    const missing = g.plan.swaps.map(
      (s) => `${colorName(s.need.color)} ${s.need.type} in ${s.slot.label}`,
    );
    p.push(
      `Not loaded yet: ${missing.join("; ")}${g.plan.unplaceable.length ? " (and more than the AMS can hold)" : ""}.`,
    );
  }
  const approvedPlan = g.approval?.plan;
  if (approvedPlan) {
    const want = approvedSlots(approvedPlan);
    for (const a of g.plan.assignments) {
      const slot = want.get(a.need.index);
      if (slot !== undefined && slot !== a.tray.trayId) {
        p.push(
          `Filament ${a.need.index} would come from ${a.tray.label}, but the approved plan used tray ${slot}. The AMS changed since the yes; ask again.`,
        );
      }
      if (!a.tray.loaded || colorDistance(a.tray.color, a.need.color) > SAME_COLOR) {
        const pinned = job.prefer[a.need.index] === a.tray.trayId;
        if (!pinned)
          p.push(`${a.tray.label} does not hold the ${colorName(a.need.color)} the design needs.`);
      }
    }
  } else if (g.approval) {
    p.push("The approval has no filament plan attached. Ask again with print_request_approval.");
  }

  // The plate: the independent look says clear, or the approver confirmed it from a photo.
  const after = g.decision?.ms ?? Number.POSITIVE_INFINITY;
  if (g.ownLookMs === null || g.ownLookMs < after) {
    p.push(
      "Look at the plate yourself first: take a printer_camera frame after the yes and pass its frame id.",
    );
  }
  const confirm = plateConfirmation({
    now: g.now,
    job,
    printYesMs: g.decision?.ms ?? null,
    plateConfirm: g.plateConfirm,
    approvers: g.approvers,
  });
  if (confirm.state === "valid") {
    // The approver looked at the photo and said it is clear; that is the plate check.
  } else if (confirm.state === "waiting" || confirm.state === "invalid") {
    p.push(confirm.problem);
  } else if (!g.plateLook) p.push("The independent plate check did not run.");
  else {
    if (g.plateLook.verdict !== "CLEAR") {
      p.push(
        `The independent look at the plate says ${g.plateLook.verdict.toLowerCase()}: ${g.plateLook.note || "no detail"}. If the plate needs clearing, ask for that. If you think it is clear, send the approver your photo and ask them to confirm: print_request_approval with action "plate" and your frame_id. Their yes counts as the plate check.`,
      );
    }
    if (g.plateLook.frameMs < after || g.now - g.plateLook.frameMs > PLATE_LOOK_MAX_AGE_MS) {
      p.push(
        "The plate check must be on a frame taken after the yes and within the last five minutes.",
      );
    }
  }

  return { ok: p.length === 0, problems: p, route };
}

/** The same rules for cancel and resume: an approver's fresh yes to that action, from the conversation that asked. */
export function checkControlGate(g: {
  now: number;
  callerSession: string;
  approval: Approval | null;
  decision: Decision | null;
  approvers: string[];
  ttlMs: number;
  action: "cancel" | "resume";
}): { ok: boolean; problems: string[] } {
  const p: string[] = [];
  const a = g.approval;
  if (!a || a.action !== g.action) {
    p.push(
      `Nobody has been asked to approve this ${g.action} yet. Use print_request_approval with action "${g.action}".`,
    );
  } else {
    if (a.sessionKey !== g.callerSession)
      p.push(`Only the conversation that asked may ${g.action}.`);
    if (!["pending", "approved"].includes(a.status))
      p.push(`The approval is ${a.status}; ask again.`);
    const d = g.decision;
    if (!d) p.push(`No yes from the approver yet. Do not ${g.action} until there is one.`);
    else {
      if (d.verdict !== "approve") p.push(`The approver said no ("${d.text}").`);
      if (!g.approvers.includes(d.by)) p.push("The yes did not come from an approver.");
      if (d.ms <= a.askedMs) p.push("The yes came before the ask.");
      if (g.now - d.ms > Math.min(g.ttlMs, 2 * 3600_000)) p.push("The yes is too old; ask again.");
    }
  }
  return { ok: p.length === 0, problems: p };
}
