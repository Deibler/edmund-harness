import type { Config } from "../config/config.ts";
import type { CronStore } from "../cron/store.ts";
import type { ChatDb } from "../imessage/db.ts";
import { getGroupParticipants, handleExists } from "../imessage/participants.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, isGroupSession, normalizeHandle } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { stageRelayMedia } from "./relay-media.ts";

/**
 * Cross-session message relay.
 *
 * Architecture: a one-shot cron job whose target is the *recipient's*
 * session. The existing cron-fire pipeline picks it up under the target's
 * lock, spawns claude -p with the synthetic envelope, and the recipient's
 * session-bot handles it as if a "Relay from X" event had landed.
 *
 * No new transport — `cron/fire.ts` already delivers system events into
 * arbitrary sessions, which is exactly what relay needs. See
 * docs/design/relay-plan.md for the design rationale.
 */

export const MAX_RELAY_DEPTH = 3;
const RELAY_HEADER_RX = /^\[Relay from (.+?) · depth=(\d+)\]/;

export type RelayInput = {
  /** Display name of the originator (the human whose session is calling send_message). */
  originatorDisplayName: string;
  /** Originator's normalized handle, used for group-membership validation. */
  originatorHandle: string;
  message: string;
  additionalContext: string | null;
  isGroupChat: boolean;
  /** Required iff !isGroupChat. Raw, will be normalized. */
  phoneNumber?: string;
  /** Required iff isGroupChat. Stable chat.guid. */
  groupChatId?: string;
  /**
   * Depth of the inbound envelope this relay is being fired in response to.
   * 0 if the originating turn was a fresh inbound; N if the originating
   * turn was itself a relay at depth N. Used to refuse runaway loops.
   */
  inboundDepth: number;
  /**
   * Absolute paths of files the originator wants to send along — PDFs,
   * images, videos, voice memos, anything. Each is copied into the
   * recipient's sandbox before the relay job fires. Image files surface
   * as inline multimodal blocks on the receiving turn (model sees the
   * pixels directly); non-image files are listed in the envelope text
   * with their staged paths so the recipient can `send_attachment` them.
   */
  mediaPaths?: string[];
  /**
   * Tracked-ask (errand) id. When set, the receiving envelope carries a
   * report-back instruction so the recipient's session closes the loop
   * via `report_errand` instead of leaving the asker hanging.
   */
  errandId?: string;
};

export type RelayResult =
  | { ok: true; targetSessionKey: SessionKey; envelopeDepth: number }
  | { ok: false; error: string };

export type RelayDeps = {
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  state: StateStore;
  crons: CronStore;
  /** Optional: called after the relay job is inserted so the scheduler
   *  re-arms its timer immediately instead of waiting for the 15s heartbeat.
   *  Cuts relay P50 latency from "up to 15s + 1s cushion" to "now". */
  pokeScheduler?: () => void;
};

/**
 * Validate, resolve, and enqueue a relay. Returns a structured result so
 * the MCP tool can render a useful error to the model when something is
 * wrong with its arguments (vs. just crashing).
 */
export function relay(input: RelayInput, deps: RelayDeps): RelayResult {
  const validation = validateInput(input, deps.config);
  if (!validation.ok) return validation;

  const depth = input.inboundDepth + 1;
  if (depth > MAX_RELAY_DEPTH) {
    return {
      ok: false,
      error: `relay depth ${depth} exceeds max ${MAX_RELAY_DEPTH} (loop guard)`,
    };
  }

  let targetSessionKey: SessionKey;
  if (input.isGroupChat) {
    const r = resolveGroupTarget(input, deps);
    if (!r.ok) return r;
    targetSessionKey = r.sessionKey;
  } else {
    const r = resolveDmTarget(input, deps);
    if (!r.ok) return r;
    targetSessionKey = r.sessionKey;
  }

  // Stage any attached media into the recipient's sandbox BEFORE building
  // the envelope so we can mention staged paths in the text and pass
  // images through cron's attachImages for inline multimodal delivery.
  // Validation failure here cancels the whole relay — better to surface
  // "file not found" to the caller than to fire an empty relay claiming
  // attachments that aren't really there.
  const mediaPaths = input.mediaPaths ?? [];
  let stagedPaths: string[] = [];
  let stagedImagePaths: string[] = [];
  if (mediaPaths.length > 0) {
    const stage = stageRelayMedia({
      mediaPaths,
      targetSessionKey,
      originatorDisplayName: input.originatorDisplayName,
    });
    if (!stage.ok) return stage;
    stagedPaths = stage.staged.paths;
    stagedImagePaths = stage.staged.imagePaths;
  }

  const envelope = buildRelayEnvelope({
    originatorDisplayName: input.originatorDisplayName,
    message: input.message,
    additionalContext: input.additionalContext,
    depth,
    targetIsGroup: input.isGroupChat,
    stagedPaths,
    stagedImagePaths,
    errandId: input.errandId,
  });

  deps.crons.create({
    sessionKey: targetSessionKey,
    systemEvent: envelope,
    // Fire immediately — nextFire("once") now clamps past atMs to `after`, so
    // a Date.now() schedule fires on the very next scheduler tick. Combined
    // with pokeScheduler() below, the receiving session sees the envelope
    // within a few ms rather than waiting on the 15s heartbeat.
    schedule: { kind: "once", atMs: Date.now() },
    gracePeriodMs: null,
    // Images go through attachImages so the receiving turn gets them as
    // inline multimodal content blocks — model sees the pixels, no Read
    // call needed. Non-image media stays in the envelope text only.
    attachImages: stagedImagePaths.length > 0 ? stagedImagePaths : undefined,
  });
  deps.pokeScheduler?.();

  return { ok: true, targetSessionKey, envelopeDepth: depth };
}

function validateInput(
  input: RelayInput,
  config: Config,
): { ok: true } | { ok: false; error: string } {
  if (!input.message.trim()) return { ok: false, error: "message must not be empty" };

  if (input.isGroupChat) {
    if (input.phoneNumber) {
      return {
        ok: false,
        error: "is_group_chat=true forbids phone_number — pick one target type",
      };
    }
    if (!input.groupChatId) {
      return { ok: false, error: "is_group_chat=true requires group_chat_id" };
    }
  } else {
    if (input.groupChatId) {
      return {
        ok: false,
        error: "is_group_chat=false forbids group_chat_id — pick one target type",
      };
    }
    if (!input.phoneNumber) {
      return { ok: false, error: "is_group_chat=false requires phone_number" };
    }
  }

  const mode = config.outbound.mode;
  if (!mode) {
    return {
      ok: false,
      error: "outbound relay disabled in config (set [outbound] mode)",
    };
  }
  if (mode === "dm_only" && input.isGroupChat) {
    return { ok: false, error: "outbound mode is dm_only — group targets not allowed" };
  }
  if (mode === "groupchat_only" && !input.isGroupChat) {
    return {
      ok: false,
      error: "outbound mode is groupchat_only — DM targets not allowed",
    };
  }

  return { ok: true };
}

function resolveDmTarget(
  input: RelayInput,
  deps: RelayDeps,
): { ok: true; sessionKey: SessionKey } | { ok: false; error: string } {
  const raw = input.phoneNumber ?? "";
  const normalized = normalizeHandle(raw);
  if (normalized.includes("@")) {
    return { ok: false, error: "DM targets must be a phone number, not an email" };
  }
  if (!/[\d+]/.test(raw)) {
    return { ok: false, error: "phone_number must contain digits" };
  }
  if (!handleExists(deps.chatDb, normalized)) {
    return {
      ok: false,
      error: `no message history with ${normalized} — use list_contacts to see who you can text`,
    };
  }

  const canon = deps.contacts.canon(normalized);
  const sessionKey: SessionKey = `imessage:dm:${canon}`;

  // Pre-warm a session record if the recipient was only ever observed in a
  // group with the originator and never DM'd Edmund directly. The Claude
  // session UUID stays null — the receiving turn will cold-start.
  if (!deps.state.getSession(sessionKey)) {
    deps.state.upsertSession({
      sessionKey,
      claudeSessionId: null,
      chatGuid: canon,
      isGroup: 0,
      lastInboundMs: 0,
      lastOutboundMs: 0,
    });
  }

  return { ok: true, sessionKey };
}

function resolveGroupTarget(
  input: RelayInput,
  deps: RelayDeps,
): { ok: true; sessionKey: SessionKey } | { ok: false; error: string } {
  const guid = (input.groupChatId ?? "").trim();
  if (!guid) return { ok: false, error: "group_chat_id required" };
  const participants = getGroupParticipants(deps.chatDb, guid);
  if (participants.length === 0) {
    return { ok: false, error: `group ${guid} not found in chat history` };
  }
  const senderCanon = deps.contacts.canon(input.originatorHandle);
  const senderInGroup = participants.some((h) => deps.contacts.canon(h) === senderCanon);
  if (!senderInGroup) {
    return {
      ok: false,
      error: "you are not a participant of that group chat",
    };
  }
  // Group sessions are keyed by chat.guid directly. No need to pre-warm —
  // group sessions get records lazily on first inbound, and the runner
  // tolerates a missing session row by cold-starting.
  return { ok: true, sessionKey: `imessage:group:${guid}` };
}

/**
 * Build the synthetic inbound text the receiving session-bot will see.
 * The depth token at the top is what `parseInboundDepth` reads on the next
 * relay so loops can be capped.
 */
export function buildRelayEnvelope(args: {
  originatorDisplayName: string;
  message: string;
  additionalContext: string | null;
  depth: number;
  targetIsGroup: boolean;
  /** Paths inside the recipient's sandbox where ALL relay attachments
   *  were staged (images + non-images). Empty when the relay is text-only. */
  stagedPaths?: string[];
  /** Subset of stagedPaths that are images. Images also arrive as inline
   *  multimodal content blocks via cron's attachImages — surfaced here
   *  for the model so it knows which staged files it has already SEEN
   *  vs which it needs to Read. */
  stagedImagePaths?: string[];
  /** When set, append the errand report-back instruction. */
  errandId?: string;
}): string {
  const {
    originatorDisplayName,
    message,
    additionalContext,
    depth,
    targetIsGroup,
    stagedPaths = [],
    stagedImagePaths = [],
    errandId,
  } = args;
  const where = targetIsGroup ? "the group chat you are in" : "your conversation partner";
  const lines = [
    `[Relay from ${originatorDisplayName} · depth=${depth}]`,
    "",
    `${originatorDisplayName} asked you to pass this along to ${where}:`,
    `  "${message}"`,
  ];
  if (additionalContext?.trim()) {
    lines.push("", `Additional context they shared: ${additionalContext.trim()}`);
  }
  if (stagedPaths.length > 0) {
    const imgSet = new Set(stagedImagePaths);
    lines.push(
      "",
      `${originatorDisplayName} also attached ${stagedPaths.length} file(s) for you to deliver:`,
    );
    for (const p of stagedPaths) {
      const label = imgSet.has(p) ? "image (already visible above)" : "file";
      lines.push(`  - ${label}: ${p}`);
    }
    lines.push(
      "",
      "To forward an attachment to your conversation partner, call",
      "`send_attachment(file_path)` with the exact path shown above. You can",
      "preview non-image files with `Read` first if you want to know what's in",
      "them before passing them along. If the user obviously doesn't want it",
      "(e.g. they just asked you to relay text and nothing came up about media),",
      "you don't have to send everything — use judgment.",
    );
  }
  lines.push(
    "",
    "How to respond:",
    "- If you have something to convey to your conversation partner about this,",
    "  reply naturally — your text will be sent to them via iMessage as usual.",
    `- If you want to send a response back to ${originatorDisplayName}, call`,
    "  message_contact targeting their phone or group; they will see your reply.",
  );
  if (errandId) {
    lines.push(
      "",
      `This is a TRACKED ask (errand ${errandId}) — ${originatorDisplayName} is waiting on the answer.`,
      "When your conversation partner answers (or declines, or clearly isn't going to), call",
      `report_errand(errand_id: "${errandId}", answer: "<their answer, faithfully, in a sentence or two>").`,
      'Relay their words, not your spin. Don\'t leave it hanging — a "they said no" report is',
      "still a complete errand. Until reported, it will show in list_errands as owed by you.",
    );
  }
  return lines.join("\n");
}

/**
 * Recover the relay depth from an inbound envelope, if any. Returns 0 for
 * non-relay inbounds (i.e. organic iMessage events) so the next relay
 * starts at depth 1.
 */
export function parseInboundDepth(envelope: string | null | undefined): number {
  if (!envelope) return 0;
  const m = envelope.match(RELAY_HEADER_RX);
  if (!m || !m[2]) return 0;
  const n = Number.parseInt(m[2], 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * For list_contacts: human-readable timestamp ago. Kept here so it ships
 * with the relay surface and stays easy to test.
 */
export function relativeAgo(ms: number, now = Date.now()): string {
  if (!ms || ms <= 0) return "never";
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
