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

/** The six words a reaction can be sent as, for an error that lists them. */
export const REACTION_WORDS: readonly ReactionKind[] = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasis",
  "question",
];

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * True for one emoji as a person would pick it from the keyboard: a single
 * grapheme (so a skin tone, a flag or a joined family counts as one) that is
 * pictographic. A word is not one, however short.
 */
export function isSingleEmoji(text: string): boolean {
  let count = 0;
  for (const _ of graphemes.segment(text)) if (++count > 1) return false;
  return count === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text);
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
 *
 * Anything that is neither one of the six words nor an emoji is refused here,
 * where it would be sent. It used to go out as an emoji reaction whose emoji
 * was the text: "thumbs" was stored as a reaction reading "thumbs", the
 * phone had nothing to draw, and it was never delivered (twice, 2026-11-03
 * and 2026-11-25, both reported as sent).
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
  if (!classic && !isSingleEmoji(raw)) {
    return {
      ok: false,
      error: `"${raw}" is not a reaction: use ${REACTION_WORDS.join(", ")}, or one emoji`,
    };
  }
  return asSendResult(() =>
    invoke("tapback", {
      chat: args.chatGuid,
      message: args.messageGuid,
      ...(classic ? { kind: classic } : { kind: "emoji" as TapbackKind, emoji: raw }),
      ...(args.remove ? { remove: true } : {}),
    }),
  );
}
