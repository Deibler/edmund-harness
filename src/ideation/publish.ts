import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PageCheck } from "./page-check.ts";
import { type IdeationStore, ideationsDir } from "./store.ts";

/**
 * The one way a page becomes visible: it passes the check, it is copied into
 * data/ideations/<id>/ with its picture, and only then is the row marked
 * ready. The kitchen host serves nothing that is not ready, so a page that
 * failed its check, or a build that died halfway, can never reach anyone.
 */

export type PublishDeps = {
  store: IdeationStore;
  dataDir: string;
  /** The kitchen host's public origin ([shelf] origin), "" if none. */
  origin: string;
  check: (html: string) => Promise<PageCheck>;
};

export type PublishResult = { ok: true; url: string | null } | { ok: false; problems: string[] };

function attr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The tags iMessage reads to draw the link as a card with a picture, added
 * when the page has none of its own. Title and pitch are the ideation's.
 */
export function withPreviewTags(
  html: string,
  p: { title: string; description: string; imageUrl: string | null },
): string {
  if (/<meta[^>]+property=["']og:/i.test(html)) return html;
  const tags = [
    `<meta property="og:title" content="${attr(p.title)}">`,
    `<meta property="og:description" content="${attr(p.description)}">`,
    p.imageUrl ? `<meta property="og:image" content="${attr(p.imageUrl)}">` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${tags}\n</head>`)
    : `${tags}\n${html}`;
}

function writeAtomic(path: string, body: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export async function publishIdeation(
  deps: PublishDeps,
  id: string,
  htmlPath: string,
  nowMs = Date.now(),
): Promise<PublishResult> {
  const row = deps.store.get(id);
  if (!row) return { ok: false, problems: [`there is no ideation ${id}.`] };
  if (row.status !== "building") {
    return {
      ok: false,
      problems: [`ideation ${id} is ${row.status}, not waiting to be published.`],
    };
  }
  if (!existsSync(htmlPath)) return { ok: false, problems: [`there is no file at ${htmlPath}.`] };

  const origin = deps.origin.replace(/\/+$/, "");
  const html = withPreviewTags(readFileSync(htmlPath, "utf8"), {
    title: row.title,
    description: row.pitch,
    imageUrl: origin ? `${origin}/i/${id}/thumb.jpg` : null,
  });
  const check = await deps.check(html);
  if (!check.ok) return { ok: false, problems: check.problems };

  const dir = join(ideationsDir(deps.dataDir), id);
  mkdirSync(dir, { recursive: true });
  if (check.screenshot) writeAtomic(join(dir, "thumb.jpg"), check.screenshot);
  writeAtomic(join(dir, "index.html"), html);
  const url = origin ? `${origin}/i/${id}/` : null;
  if (!deps.store.markReady(id, nowMs, url)) {
    return { ok: false, problems: [`ideation ${id} stopped waiting while it was checked.`] };
  }
  return { ok: true, url };
}
