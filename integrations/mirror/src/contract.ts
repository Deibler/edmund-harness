import {
  AgentFrameSchema,
  MIRROR_PROTOCOL_VERSION,
  MirrorComponentSpecSchema,
  MirrorLifespanSchema,
  MirrorPresentationSchema,
  MirrorZoneSchema,
  PiEventSchema,
} from "./protocol.ts";

/**
 * The wire vocabulary shared with the screen, derived from the schemas.
 *
 * The Mac validates what a model may send; the Pi separately validates what
 * arrives on the socket. Both need the same lists of zones, components, phases
 * and frame types, and they live in different repositories — so for a while
 * each kept its own hand-written copy. That failed silently in the worst way:
 * the Pi's frame schema strips unknown keys rather than rejecting them, so a
 * field added here (`agents`) or a component added here (`story_list`) was
 * accepted, quietly dropped, and simply never appeared on the glass. Nothing
 * errored. The only symptom was a feature that did nothing.
 *
 * Everything below is READ OUT of the Zod schemas rather than restated. A
 * hand-written contract is just a third copy to drift; this one cannot claim a
 * component the union does not have, because it has no way to name one.
 *
 * `integrations/mirror/scripts/emit-mirror-contract.ts` writes this to mirror-contract.json, which
 * is committed here and copied into the screen's repository, where its schemas
 * are built from it. tests/mirror-contract.test.ts fails if the JSON is stale.
 */
export type MirrorContract = {
  version: number;
  zones: string[];
  components: string[];
  presentations: string[];
  lifespans: string[];
  overlayPhases: string[];
  overlayFields: string[];
  frameTypes: string[];
  piEventTypes: string[];
  wakeFields: string[];
  audioFormats: string[];
  limits: { maxContentItems: number; maxAudioBase64: number };
};

/**
 * Discriminant values of a discriminated union, in declaration order.
 *
 * An arm may discriminate on an enum rather than a literal when one shape
 * covers several type names, so both are flattened.
 */
function discriminants(schema: { options: readonly unknown[] }, key: string): string[] {
  return schema.options.flatMap((option) => {
    const field = (option as { shape: Record<string, { value?: unknown; options?: unknown }> })
      .shape[key];
    if (typeof field?.value === "string") return [field.value];
    if (Array.isArray(field?.options)) return field.options as string[];
    throw new Error(`discriminant ${key} is neither a literal nor an enum`);
  });
}

/** The object schema carried by one arm of the frame union. */
function frameArm(type: string): { shape: Record<string, unknown> } {
  const arm = AgentFrameSchema.options.find(
    (option) =>
      (option as { shape: Record<string, { value?: unknown }> }).shape.type?.value === type,
  );
  if (!arm) throw new Error(`frame type ${type} is missing from AgentFrameSchema`);
  return arm as unknown as { shape: Record<string, unknown> };
}

/** The object schema carried by one arm of the Pi -> agent event union. */
function piEventArm(type: string): { shape: Record<string, unknown> } {
  const arm = PiEventSchema.options.find(
    (option) =>
      (option as { shape: Record<string, { value?: unknown }> }).shape.type?.value === type,
  );
  if (!arm) throw new Error(`pi event type ${type} is missing from PiEventSchema`);
  return arm as unknown as { shape: Record<string, unknown> };
}

export function mirrorContract(): MirrorContract {
  // Taken from the frame union rather than from OverlayPayloadSchema directly:
  // that proves the contract describes what actually reaches the wire, not a
  // schema that merely exists.
  const overlay = frameArm("overlay_set").shape.overlay as {
    shape: Record<string, unknown>;
    _def?: unknown;
  };
  const phases = (
    overlay.shape.phase as { options?: readonly string[]; _def?: { values?: readonly string[] } }
  ).options;
  if (!phases) throw new Error("overlay.phase is not an enum");

  return {
    version: MIRROR_PROTOCOL_VERSION,
    zones: [...MirrorZoneSchema.options],
    components: discriminants(MirrorComponentSpecSchema, "component"),
    presentations: [...MirrorPresentationSchema.options],
    lifespans: [...MirrorLifespanSchema.options],
    overlayPhases: [...phases],
    overlayFields: Object.keys(overlay.shape),
    frameTypes: discriminants(AgentFrameSchema, "type"),
    // Events the screen sends BACK. It produces these rather than validating
    // them -- its own screenEventSchema covers a different hop, browser to Pi --
    // but pinning them still catches one side growing a type the other never
    // sends.
    piEventTypes: discriminants(PiEventSchema, "type"),
    // Tracked for the same reason overlayFields is. `wake` is the one event
    // travelling Pi -> agent that carries optional fields, and zod STRIPS
    // unknown keys rather than rejecting them — so a screen sending a wake
    // confidence to an agent that does not know the field would have it
    // silently dropped, and the agent would go on verifying transcripts
    // forever without anything ever erroring.
    wakeFields: Object.keys(piEventArm("wake").shape),
    audioFormats: [...enumOptions(frameArm("audio_play").shape.format, "audio_play.format")],
    // Read off the schema rather than restated as constants. These bounds are
    // written inline at their use sites, and a contract that named its own
    // numbers could disagree with the validator that enforces them.
    limits: {
      maxContentItems: arrayMax(frameArm("snapshot").shape.contents, "snapshot.contents"),
      maxAudioBase64: stringMax(frameArm("audio_play").shape.data, "audio_play.data"),
    },
  };
}

function enumOptions(schema: unknown, label: string): readonly string[] {
  const options = (schema as { options?: readonly string[] }).options;
  if (!options) throw new Error(`${label} is not an enum`);
  return options;
}

function arrayMax(schema: unknown, label: string): number {
  const value = (schema as { _def?: { maxLength?: { value?: number } } })._def?.maxLength?.value;
  if (typeof value !== "number") throw new Error(`${label} has no max length`);
  return value;
}

function stringMax(schema: unknown, label: string): number {
  const checks = (schema as { _def?: { checks?: Array<{ kind: string; value: number }> } })._def
    ?.checks;
  const max = checks?.find((check) => check.kind === "max")?.value;
  if (typeof max !== "number") throw new Error(`${label} has no max length`);
  return max;
}

/**
 * Stable fingerprint of the contract.
 *
 * Sent by the screen when it connects and compared against ours, so the case
 * this whole file exists to prevent — the two repositories disagreeing — is
 * reported the moment a screen attaches rather than discovered later as a
 * feature that quietly does nothing. Key order is fixed by the literal above,
 * so the digest changes only when the vocabulary does.
 */
export function contractDigest(contract: MirrorContract = mirrorContract()): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(contract));
  return hasher.digest("hex").slice(0, 16);
}
