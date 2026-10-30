/**
 * What the model is told, every turn, while its conversation is on a call.
 *
 * Per turn rather than in the system prompt: a warm worker never reloads its
 * system prompt, and swapping it at both ends of a call would cost a cold
 * respawn and a cache miss each time. This block costs a few hundred tokens on
 * call turns only.
 */

export type CallEnvelopeInput = {
  provider: string;
  label: string;
  isGroup: boolean;
  direction: "incoming" | "outgoing";
  answeredAtMs: number | null;
  nowMs: number;
  /** What Edmund said that the caller did not hear, if they cut him off. */
  cutOff: string | null;
};

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
}

export function callEnvelopeBlock(input: CallEnvelopeInput): string {
  const who = input.isGroup ? `the group ${input.label}` : input.label;
  const state =
    input.answeredAtMs === null
      ? input.direction === "incoming"
        ? "it is ringing; you pick up in a moment"
        : "it is ringing on their end"
      : `${minutes(input.nowMs - input.answeredAtMs)} in`;
  const lines = [
    `[On a ${input.provider} call with ${who}: ${state}]`,
    "You are talking out loud. Your reply is spoken to them as you write it.",
    "- Talk the way a person does on the phone: a sentence or three, no lists, no links, no formatting.",
    "- Never leave them waiting in silence. Anything slower than a few seconds (a search, research, a long tool) goes to a background agent with spawn_agent; say you're on it and keep talking. Its result comes back to you here while you're still on the call.",
    "- send_message still texts them, for anything better read than heard: a link, an address, a list.",
    "- end_call hangs up. Say goodbye first.",
  ];
  if (input.isGroup) {
    lines.push("- Several people may be talking; you hear them mixed, without names.");
  }
  if (input.cutOff) {
    lines.push(`They talked over you. They did not hear: "${input.cutOff.slice(0, 400)}"`);
  }
  return lines.join("\n");
}
