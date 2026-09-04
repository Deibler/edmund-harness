import type { TapbackKind } from "imcore-bridge";

import { invoke } from "../bridge/index.ts";
import type { SendResult } from "../types.ts";
import { asSendResult } from "./result.ts";

/** The six classic iMessage tapbacks. Any single emoji also works. */
export type ReactionKind = "love" | "like" | "dislike" | "laugh" | "emphasis" | "question";

/** Our reaction words, and what IMCore calls them. */
const CLASSIC: Record<string, TapbackKind> = {
  love: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  emphasis: "emphasize",
  emphasize: "emphasize",
  question: "question",
};

/** The IMCore kind for a classic reaction word, or null if it is not one. */
function classicTapbackKind(kind: string): TapbackKind | null {
  return CLASSIC[kind.trim().toLowerCase()] ?? null;
}

/**
 * Reacts to a specific message.
 *
 * Every reaction now takes this one path. Previously the classic six went
 * through IMCore while an emoji fell back to driving the Messages UI with System
 * Events — which needed an Accessibility grant, could only ever touch the newest
 * message in the thread, and meant "react 🎉 to what you said earlier" was
 * refused outright. IMCore sends emoji tapbacks as first-class objects, so the
 * UI-scripting path is gone and any message can be reacted to with anything.
 */
export async function sendTapback(args: {
  chatGuid: string;
  messageGuid: string;
  kind: ReactionKind | string;
  remove?: boolean;
}): Promise<SendResult> {
  const raw = args.kind.trim();
  if (!raw) return { ok: false, error: "empty reaction" };

  const classic = classicTapbackKind(raw);
  return asSendResult(() =>
    invoke("tapback", {
      chat: args.chatGuid,
      message: args.messageGuid,
      ...(classic ? { kind: classic } : { kind: "emoji" as TapbackKind, emoji: raw }),
      ...(args.remove ? { remove: true } : {}),
    }),
  );
}
