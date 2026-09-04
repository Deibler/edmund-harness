import type { ImcoreBridge } from "imcore-bridge";

import { healMessagingRegistry } from "./host.ts";
import type { BridgeOp, OpArgs, OpResult } from "./protocol.ts";

/**
 * Every operation the harness performs on Messages, in one place.
 *
 * This is the only file that names imcore-bridge methods. The daemon runs these
 * against its own bridge; a subprocess reaches the same functions over the
 * control socket. Keeping them together is what makes those two paths provably
 * the same behaviour rather than two copies to keep in step.
 *
 * Handlers do no error handling of their own. imcore-bridge raises typed errors
 * — unsupported feature, RPC timeout, chat not found — and swallowing any of
 * them here would turn a visible failure into a silent one.
 */
type Handlers = {
  [K in BridgeOp]: (bridge: ImcoreBridge, args: OpArgs<K>) => Promise<OpResult<K>>;
};

const handlers: Handlers = {
  send: (bridge, args) => bridge.send(args),
  sendStatus: (bridge, args) => bridge.sendStatus(args.guid),
  typing: (bridge, args) => bridge.setTyping(args),
  tapback: (bridge, args) => bridge.tapback(args),
  edit: (bridge, args) => bridge.edit(args),
  retract: (bridge, args) => bridge.retract(args),
  deleteMessages: (bridge, args) => bridge.deleteMessages(args),
  deleteChat: (bridge, args) => bridge.deleteChat(args.chat),
  markRead: (bridge, args) => bridge.markRead(args.chat),
  notifyAnyway: (bridge, args) => bridge.notifyAnyway(args.chat, args.message),
  groupRename: (bridge, args) => bridge.group.rename(args.chat, args.name),
  groupAddMembers: (bridge, args) => bridge.group.addMembers(args.chat, args.members),
  groupRemoveMembers: (bridge, args) => bridge.group.removeMembers(args.chat, args.members),
  groupLeave: (bridge, args) => bridge.group.leave(args.chat),
  groupPhoto: (bridge, args) => bridge.setGroupPhoto(args.chat, args.file),
  createChat: (bridge, args) => bridge.createChat(args.handles, args.name),
  account: (bridge) => bridge.account(),
  status: (bridge) => bridge.status(),
  whois: (bridge, args) => bridge.whois(args.handle),
  resolveChat: (bridge, args) => bridge.resolveChat(args.chat),
  // Not a bridge method: the heal belongs to the supervisor, and only the
  // daemon has one. Serving it here is what lets a subprocess reach it over
  // the control socket through the same vocabulary as everything else.
  healRegistry: async (_bridge, args) => ({ outcome: await healMessagingRegistry(args.reason) }),
};

/** Whether a name off the wire is an operation we serve. */
export function isBridgeOp(name: unknown): name is BridgeOp {
  return typeof name === "string" && Object.hasOwn(handlers, name);
}

/** Runs an operation against a bridge this process owns. */
export function runOp<K extends BridgeOp>(
  bridge: ImcoreBridge,
  op: K,
  args: OpArgs<K>,
): Promise<OpResult<K>> {
  return handlers[op](bridge, args);
}
