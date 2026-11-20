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
  /** Things that happened on the line that this turn should know, each told once. */
  notes?: string[];
  /** The line says a short sound of thinking when a reply is slow to start. */
  thinkingSounds?: boolean;
  /** Another conversation asked for this call, and is told what was said when it ends. */
  askedElsewhere?: boolean;
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
    // Replies to "a sentence or two" averaged 330 characters, about twenty
    // seconds of unbroken talking, on the 2026-11-05 calls: the limit is
    // stated as time and given its reason, and a long answer has a shape.
    "- Talk the way a person does on the phone: one or two short sentences, then stop and let them talk. They cannot skim or scroll back, so more than about ten seconds of you talking is a speech. If the answer is long, give the first part and ask if they want the rest. One question at a time. No lists, no links, no formatting.",
    "- Open with a short sentence. Your first sentence is turned into speech before the rest, so a short one reaches them sooner.",
    '- Say numbers, times and amounts the way they are said aloud ("seven thirty", "about twenty dollars").',
    "- When they say several things in a row, answer them together in one reply, not one by one.",
    '- Never leave them waiting in silence. Answer out loud first; anything else (remembering something, a note, a text) comes after your spoken reply. If a tool has to come first, write a few words before it ("On it.", "One sec."): they are spoken while it runs.',
    "- On a call you cannot run commands, fetch pages or search the web yourself. Anything like that, or anything slower than a few seconds, goes to a background agent with spawn_agent; keep talking while it works. Its result comes back to you here while you're still on the call.",
    // "(or anyone else)" stood here, and a report meant for the person who
    // asked for a call was texted to the person called (2026-11-12).
    `- send_message texts ${who}, the same person you are talking to, for anything better read than heard: a link, an address, a list. It reaches no one else; message_contact is how you tell another person something.`,
    "- end_call hangs up once what you've already said has finished playing. Say goodbye first, in the same reply.",
  ];
  if (input.thinkingSounds) {
    lines.push(
      '- If you are slow to start, the line says a short "hmm" for you. Do not open with one yourself.',
    );
  }
  if (input.direction === "outgoing") {
    lines.push("- If what you hear is a voicemail greeting, leave one short message and end_call.");
  }
  if (input.askedElsewhere) {
    lines.push(
      "- You placed this call because another conversation asked you to. That conversation is given everything said here as soon as the call ends, so there is nothing for you to report, during the call or after it.",
    );
  }
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
  for (const note of input.notes ?? []) lines.push(note);
  return lines.join("\n");
}
