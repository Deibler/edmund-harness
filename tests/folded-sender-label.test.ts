/**
 * A message folded into a running turn (the coalesce gate) gets an envelope
 * of its own, and its From line must name whoever wrote it. It named the
 * turn's first sender: in groups, 13 of 20 measured folds came from someone
 * else, so the model answered the wrong person.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { senderLabelFor } from "../src/channels/turn.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

const names: Record<string, string> = { "+15550100031": "Riley", "+15550100032": "Jordan" };
const contacts = { label: (h: string) => names[h] ?? null };
const msg = (fromHandle: string) =>
  ({ fromHandle, chatIdentifier: "chat5550100" }) as unknown as InboundMessage;

describe("senderLabelFor", () => {
  test("names this iteration's writers, once each, in order", () => {
    expect(senderLabelFor([msg("+15550100032")], contacts)).toBe("Jordan");
    expect(
      senderLabelFor([msg("+15550100031"), msg("+15550100032"), msg("+15550100031")], contacts),
    ).toBe("Riley, Jordan");
    expect(senderLabelFor([msg("+15550100039")], contacts)).toBe("+15550100039");
  });

  test("the envelope of every iteration is labelled from its own messages", () => {
    const turn = readFileSync(join(import.meta.dir, "../src/channels/turn.ts"), "utf8");
    const call = turn.slice(turn.indexOf("const baseEnvelope = buildEnvelope({"));
    expect(call.slice(0, 400)).toMatch(/senderLabel: senderLabelFor\(cleaned, contacts\),/);
  });
});
