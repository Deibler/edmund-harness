import type { SendOptions, TapbackKind } from "imcore-bridge";

/**
 * The vocabulary the harness speaks to Messages, and the envelope it travels in
 * when the caller is not the process holding the bridge.
 *
 * One map defines both. Adding an operation means one entry here and one case
 * in `ops.ts`; the control server, the control client and every caller pick the
 * new shape up from the types rather than needing to be edited in step.
 *
 * The daemon holds the only bridge, because the socket the injected code dials
 * has exactly one owner. Callers in a `claude -p` subprocess reach the same
 * operations over the control socket, so the two paths are the same vocabulary
 * with a different transport, not two implementations that can drift.
 */
/**
 * An operation that answers with nothing.
 *
 * Named so the intent reads as "no result" rather than as a value that might be
 * undefined, and so the lint exemption is stated once rather than at every use.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: an operation answering with nothing is precisely the meaning here
type Ack = void;

interface OpMap {
  send: {
    args: SendOptions;
    result: { guid: string; service?: string; duplicate?: boolean; recipient?: string };
  };
  /** What became of a send, by GUID. Answers "did it land" without guessing. */
  sendStatus: {
    args: { guid: string };
    result: unknown;
  };
  typing: {
    args: { chat: string; typing: boolean };
    result: Ack;
  };
  tapback: {
    args: {
      chat: string;
      message: string;
      kind: TapbackKind;
      emoji?: string;
      remove?: boolean;
    };
    result: Ack;
  };
  edit: {
    args: { chat: string; message: string; text: string };
    result: Ack;
  };
  retract: {
    args: { chat: string; message: string };
    result: Ack;
  };
  deleteMessages: {
    args: { chat: string; messages: string[] };
    result: { deleted: number; requested: number; matched: number };
  };
  /** Removes an entire conversation, the way the app's Delete Conversation
   *  does — through IMCore, so the removal syncs rather than being resurrected
   *  from another device the way raw chat.db surgery is. */
  deleteChat: {
    args: { chat: string };
    result: { deleted: boolean };
  };
  markRead: {
    args: { chat: string };
    result: Ack;
  };
  notifyAnyway: {
    args: { chat: string; message: string };
    result: Ack;
  };
  groupRename: {
    args: { chat: string; name: string };
    result: unknown;
  };
  groupAddMembers: {
    args: { chat: string; members: string[] };
    result: unknown;
  };
  groupRemoveMembers: {
    args: { chat: string; members: string[] };
    result: unknown;
  };
  groupLeave: {
    args: { chat: string };
    result: unknown;
  };
  groupPhoto: {
    args: { chat: string; file?: string };
    result: Ack;
  };
  createChat: {
    args: { handles: string[]; name?: string };
    result: unknown;
  };
  account: {
    args: Record<string, never>;
    result: unknown;
  };
  status: {
    args: Record<string, never>;
    result: unknown;
  };
  whois: {
    args: { handle: string };
    result: unknown;
  };
  /**
   * Which conversation an address or GUID names, without sending anything.
   *
   * Read-only, and the answer to "did we address the chat we meant". Worth
   * having permanently: a send goes wherever the chat resolves to, so when a
   * message lands in the wrong thread this is the only way to see why.
   */
  resolveChat: {
    args: { chat: string };
    result: unknown;
  };
  /**
   * Rebuilds the chat registry the daemon supervises (a Messages relaunch),
   * because the caller's send resolved into our own thread.
   *
   * Exists so a subprocess gets the same self-route recovery the daemon has:
   * before this, an MCP send that hit a poisoned chat failed on first
   * detection — the one process talking to the user was the one process that
   * could not heal. The daemon rate-limits and coalesces underneath, so
   * callers request it freely on evidence and ride whatever heal runs.
   */
  healRegistry: {
    args: { reason: string };
    result: { outcome: "healed" | "throttled" };
  };
}

export type BridgeOp = keyof OpMap;
export type OpArgs<K extends BridgeOp> = OpMap[K]["args"];
export type OpResult<K extends BridgeOp> = OpMap[K]["result"];

export type ControlResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: WireError };

/**
 * An error as it crosses the control socket.
 *
 * `name` and `code` are carried so the receiving side can tell an unsupported
 * feature from a wedged bridge from a chat that does not exist, rather than
 * collapsing every failure into one opaque string.
 */
export interface WireError {
  message: string;
  name: string;
  code?: string;
}

/**
 * Frames are newline-delimited JSON, so the cap is a guard against a
 * pathological line rather than a real limit — attachments cross as paths, and
 * message text is chunked long before this.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Environment variable the daemon uses to hand subprocesses the socket path. */
export const CONTROL_SOCKET_ENV = "EDMUND_BRIDGE_SOCK";
