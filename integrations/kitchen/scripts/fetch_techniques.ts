/**
 * Pull the reference photographs into an artifact directory.
 *
 * Downloaded rather than hotlinked: the page sits behind a share token, and
 * pointing <img> at upload.wikimedia.org would both leak which recipe is open
 * and break the day Commons rate-limits a residential IP. Re-runnable; existing
 * files are left alone.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TECHNIQUES } from "../src/techniques.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: fetch_techniques.ts <artifact-dir>");
const out = join(dir, "img", "technique");
mkdirSync(out, { recursive: true });

const UA = "edmund-kitchen/1.0 (https://commons.wikimedia.org; bot@example.com)";
const api = "https://commons.wikimedia.org/w/api.php";

type CommonsPage = {
  imageinfo?: Array<{ thumburl?: string; url?: string }>;
};

type CommonsResponse = {
  query?: { pages?: Record<string, CommonsPage> };
};

for (const t of TECHNIQUES) {
  if (!t.image) continue;
  const dest = join(out, `${t.id}.${t.image.ext}`);
  if (existsSync(dest)) {
    console.log(`  have ${t.id}`);
    continue;
  }
  const u = `${api}?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=1000&titles=${encodeURIComponent(t.image.file)}`;
  const meta = (await (
    await fetch(u, { headers: { "User-Agent": UA } })
  ).json()) as CommonsResponse;
  const page = Object.values(meta.query?.pages ?? {})[0];
  // thumburl, not url: an SVG's own url is the vector, which we want rasterised,
  // and a 6000px original is a page nobody on a phone will wait for.
  const src = page?.imageinfo?.[0]?.thumburl ?? page?.imageinfo?.[0]?.url;
  if (!src) {
    console.log(`  MISS ${t.id}: ${t.image.file}`);
    continue;
  }
  const res = await fetch(src, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.log(`  MISS ${t.id}: http ${res.status}`);
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 4000) {
    console.log(`  MISS ${t.id}: ${bytes.length}b`);
    continue;
  }
  writeFileSync(dest, bytes);
  console.log(`  ${t.id}: ${Math.round(bytes.length / 1024)}kb  ${t.image.license}`);
  await new Promise((r) => setTimeout(r, 900));
}
console.log("done");
