/**
 * The shapes core uses from the mirror integration.
 *
 * The mirror is loaded by name at runtime, so core cannot import its types —
 * it has to compile on a machine where the integration is not installed at all.
 * These describe only what core actually touches, which is what makes the
 * dynamic exports type-checked at the call site instead of `any`.
 *
 * They are a contract: if the integration changes one of these shapes, the
 * mismatch should be corrected here rather than widened away.
 */

/** A row the mirror renders. Open-ended because the component spec is spread in. */
type MirrorContent = {
  id: string;
  page: string;
  zone: string;
  presentation: string;
  lifespan?: string;
  priority?: number;
  expiresAtMs?: number;
  component?: string;
  [key: string]: unknown;
};

/** A command queued for the glass — overlays, phase changes. */
type MirrorCommand = {
  v: number;
  id: string;
  type: string;
  [key: string]: unknown;
};

interface MirrorStoreLike {
  upsertContent(content: MirrorContent, source: string): void;
  enqueueCommand(command: MirrorCommand): void;
  close(): void;
}

/** `new MirrorStore(dataDir)`. */
export type MirrorStoreCtor = new (dataDir: string) => MirrorStoreLike;

/** A file published to the mirror, as `publishMirrorAsset` returns it. */
type MirrorAsset = {
  name: string;
  mime: string;
  [key: string]: unknown;
};

/** How a published asset should be drawn. */
type MirrorComponentSpec = {
  component: string;
  [key: string]: unknown;
};

export type PublishMirrorAsset = (path: string, config: unknown) => Promise<MirrorAsset>;

export type MirrorComponentForAsset = (
  asset: MirrorAsset,
  caption: unknown,
  path: string,
) => MirrorComponentSpec;
