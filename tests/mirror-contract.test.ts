import { describe, expect, test } from "bun:test";
import {
  CONTRACT_PATH,
  contractJson,
} from "../integrations/mirror/scripts/emit-mirror-contract.ts";
import { contractDigest, mirrorContract } from "../integrations/mirror/src/contract.ts";
import {
  AgentFrameSchema,
  MirrorComponentSpecSchema,
  PiEventSchema,
} from "../integrations/mirror/src/protocol.ts";

/**
 * The screen validates the same frames from a separate repository, and its
 * schema STRIPS unknown keys rather than rejecting them. So when the two
 * vocabularies disagreed, nothing failed: `agents` and `story_list` were
 * accepted on the wire, silently dropped, and never reached the glass. The
 * only symptom was a feature that did nothing, which is the most expensive
 * kind of bug to chase.
 *
 * This suite makes the committed contract the thing that breaks instead.
 */
describe("mirror wire contract", () => {
  test("the committed JSON matches the schemas", async () => {
    const committed = await Bun.file(CONTRACT_PATH)
      .text()
      .catch(() => "");
    // If this fails you changed the shared vocabulary. Run:
    //   bun integrations/mirror/scripts/emit-mirror-contract.ts --to <screen-repo>/src/mirror
    expect(committed).toBe(contractJson());
  });

  test("the digest changes when the vocabulary does", () => {
    const base = mirrorContract();
    const before = contractDigest(base);
    expect(contractDigest({ ...base })).toBe(before);
    expect(contractDigest({ ...base, components: [...base.components, "invented"] })).not.toBe(
      before,
    );
  });

  test("it reports every component the model can actually send", () => {
    // Derived, not restated — the point is that it cannot name a component the
    // union does not have, nor miss one the union gained.
    const fromUnion = MirrorComponentSpecSchema.options.map(
      (option) =>
        (option as unknown as { shape: { component: { value: string } } }).shape.component.value,
    );
    expect(mirrorContract().components).toEqual(fromUnion);
    // The two that drifted in practice.
    expect(mirrorContract().components).toContain("story_list");
  });

  test("it reports every overlay field, including the optional ones", () => {
    // `agents` is optional, and optional is exactly what got dropped silently:
    // a screen that ignores it shows a plain working knot instead of the
    // delegating presence, with nothing anywhere saying why.
    const fields = mirrorContract().overlayFields;
    expect(fields).toContain("agents");
    expect(fields).toContain("detail");
    expect(fields).toContain("messages");
    expect(fields[0]).toBe("phase");
  });

  test("limits come off the schema that enforces them", () => {
    const { limits } = mirrorContract();
    const snapshot = AgentFrameSchema.options.find(
      (option) =>
        (option as unknown as { shape: { type: { value: string } } }).shape.type.value ===
        "snapshot",
    );
    const contents = (snapshot as unknown as { shape: { contents: unknown } }).shape.contents;

    // A contract that named its own numbers could disagree with the validator.
    // Proven by construction: one over the stated limit must be rejected.
    const overLimit = Array.from({ length: limits.maxContentItems + 1 }, () => ({}));
    expect(
      (contents as { safeParse: (v: unknown) => { success: boolean } }).safeParse(overLimit)
        .success,
    ).toBe(false);
  });

  test("it reports the wake fields, including the confidence", () => {
    // Same hazard as overlayFields, in the opposite direction: `wake` travels
    // Pi -> agent, and zod strips unknown keys rather than rejecting them. An
    // agent that did not know `score` would silently drop it and go on
    // re-reading transcripts forever, with nothing anywhere erroring — the
    // exact shape of the `agents` bug that made this contract necessary.
    const fields = mirrorContract().wakeFields;
    expect(fields).toContain("score");
    expect(fields).toContain("label");

    // And the schema must actually accept one, not merely list it.
    const wake = PiEventSchema.options.find(
      (option) =>
        (option as unknown as { shape: { type: { value: string } } }).shape.type.value === "wake",
    );
    const parsed = (
      wake as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
    ).safeParse({ v: 2, type: "wake", id: "wake:abc", score: 0.87, label: "edmund" });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { score?: number }).score).toBe(0.87);
  });

  test("every frame type the agent sends is listed", () => {
    const contract = mirrorContract();
    for (const type of ["snapshot", "overlay_set", "audio_play", "content_upsert"]) {
      expect(contract.frameTypes).toContain(type);
    }
  });
});
