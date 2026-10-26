/**
 * Builds a print page's 3D view (src/viewer-model.ts) in a process of its own.
 * Usage: bun viewer-model.ts <sliced.3mf> <plate> <out dir>
 * Writes viewer.bin, then viewer.json last, so a reader that finds the JSON
 * finds the data with it. A failure writes viewer.json with an error instead.
 */
import { join } from "node:path";
import { atomicWriteFileSync } from "../../../src/util/atomic-write.ts";
import { buildViewerModel } from "../src/viewer-model.ts";

const [file, plate, out] = process.argv.slice(2);
if (!file || !plate || !out) {
  console.error("usage: viewer-model.ts <sliced.3mf> <plate> <out dir>");
  process.exit(2);
}
try {
  const { info, bin } = await buildViewerModel(file, Number(plate));
  atomicWriteFileSync(join(out, "viewer.bin"), bin);
  atomicWriteFileSync(join(out, "viewer.json"), JSON.stringify(info));
} catch (e) {
  atomicWriteFileSync(join(out, "viewer.json"), JSON.stringify({ error: (e as Error).message }));
  process.exit(1);
}
