/**
 * The harness's iMessage actions.
 *
 * Everything here reaches Messages through the single bridge surface in
 * `bridge/`. What used to live in this file — a CLI probe, four send paths, an
 * AppleScript builder, argv escaping, a bridge-relaunch cooldown and a
 * chat.db echo check to guess whether a timed-out send had actually landed — is
 * gone. One path, typed errors, and an idempotency key that makes a retry safe.
 *
 * Kept as a barrel so the call sites that import from here did not all have to
 * move in the same change.
 */
export { sendMessage, type SendArgs } from "./actions/send.ts";
export { configureSendVerification } from "./actions/verify.ts";
export { isPermanentSendError } from "./actions/classify.ts";
export { EXPRESSIVE_EFFECTS } from "./actions/effects.ts";
export { sendTapback } from "./actions/reactions.ts";
export { deleteMessage, editMessage, unsendMessage } from "./actions/edits.ts";
export {
  renameGroup,
  setGroupPhoto,
  addGroupMember,
  removeGroupMember,
  leaveGroup,
  createChat,
} from "./actions/groups.ts";
