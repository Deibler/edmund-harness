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
  /** What the caller did not hear, and why. */
  cutOff: { kind: "talked-over" | "kept-talking"; text: string } | null;
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
    "- Talk the way a person does on the phone: usually a sentence or two, then stop and let them talk. One question at a time. No lists, no links, no formatting.",
    "- When they say several things in a row, answer them together in one reply, not one by one.",
    '- Never leave them waiting in silence. Answer out loud first; anything else (remembering something, a note, a text) comes after your spoken reply. If a tool has to come first, write a few words before it ("On it.", "One sec."): they are spoken while it runs.',
    "- On a call you cannot run commands, fetch pages or search the web yourself. Anything like that, or anything slower than a few seconds, goes to a background agent with spawn_agent; keep talking while it works. Its result comes back to you here while you're still on the call.",
    "- send_message still texts them (or anyone else), for anything better read than heard: a link, an address, a list.",
    "- end_call hangs up once what you've already said has finished playing. Say goodbye first, in the same reply.",
  ];
  if (input.isGroup) {
    lines.push("- Several people may be talking; you hear them mixed, without names.");
  }
  if (input.cutOff?.kind === "talked-over") {
    lines.push(`They talked over you. They did not hear: "${input.cutOff.text.slice(0, 400)}"`);
  } else if (input.cutOff?.kind === "kept-talking") {
    lines.push(
      `They kept talking before you answered, so they never heard your last reply: "${input.cutOff.text.slice(0, 400)}". Answer everything they have said since then as one reply.`,
    );
  }
  return lines.join("\n");
}
