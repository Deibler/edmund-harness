import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../../src/util/atomic-write.ts";
import { printerDir } from "./store.ts";

/**
 * MakerWorld, Bambu's model site, through the same cloud API Bambu Studio
 * uses (api.bambulab.com). Bambu publishes no developer API or keys; these
 * routes are the app's own, verified 2026-10-25.
 *
 * Searching and reading a model are public. Downloading a model's project
 * file needs an account token, obtained once with an emailed one-time code
 * (no password is ever stored) and kept owner-readable in the data dir.
 */

const API = "https://api.bambulab.com";
const HEADERS = {
  "User-Agent": "bambu_network_agent/02.08.02",
  "X-BBL-Client-Name": "BambuStudio",
  "X-BBL-Client-Type": "slicer",
  "X-BBL-Language": "en-US",
  "Content-Type": "application/json",
};

/** The P2S's model code in MakerWorld's compatibility lists. */
export const P2S_MODEL = "N7";

export type Cloud = {
  account: string;
  accessToken: string;
  refreshToken: string;
  expiresMs: number;
};

function cloudPath(dataDir: string): string {
  return join(printerDir(dataDir), "bambu-cloud.json");
}

export function readCloud(dataDir: string): Cloud | null {
  const p = cloudPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as Cloud;
    return c.accessToken ? c : null;
  } catch {
    return null;
  }
}

function saveCloud(dataDir: string, c: Cloud): void {
  mkdirSync(printerDir(dataDir), { recursive: true });
  atomicWriteFileSync(cloudPath(dataDir), JSON.stringify(c));
  chmodSync(cloudPath(dataDir), 0o600);
}

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...HEADERS, ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: res.status, json, text };
}

/** Step one of signing in: Bambu emails a one-time code to the account. */
export async function sendLoginCode(email: string): Promise<void> {
  const r = await call("/v1/user-service/user/sendemail/code", {
    body: { email, type: "codeLogin" },
  });
  if (r.status !== 200)
    throw new Error(`Bambu did not send a code (${r.status}): ${r.text.slice(0, 200)}`);
}

/** Step two: trade the code for a token, saved for later calls. */
export async function verifyLoginCode(
  dataDir: string,
  email: string,
  code: string,
): Promise<Cloud> {
  const r = await call("/v1/user-service/user/login", {
    body: { account: email, code: code.trim() },
  });
  const token = String(r.json.accessToken ?? "");
  if (!token) {
    const c = Number(r.json.code);
    throw new Error(
      c === 1
        ? "That code has expired; ask for a new one."
        : c === 2
          ? "That code is wrong."
          : `Login failed (${r.status}).`,
    );
  }
  const cloud: Cloud = {
    account: email,
    accessToken: token,
    refreshToken: String(r.json.refreshToken ?? ""),
    expiresMs: Date.now() + Number(r.json.expiresIn ?? 0) * 1000,
  };
  saveCloud(dataDir, cloud);
  return cloud;
}

/**
 * The printer's name on the Bambu account, looked up by serial. Bambu Connect
 * shows printers only by this name, so it is how a send is checked to be going
 * to this printer.
 */
export async function boundPrinterName(dataDir: string, serial: string): Promise<string> {
  const r = await call("/v1/iot-service/api/user/bind", { token: await token(dataDir) });
  if (r.status !== 200) throw new Error(`Bambu did not list the account's printers (${r.status}).`);
  const devices = (r.json.devices ?? []) as Array<{ dev_id?: string; name?: string }>;
  const mine = devices.find((d) => d.dev_id === serial);
  if (!mine?.name)
    throw new Error(`The printer ${serial} is not bound to the signed-in Bambu account.`);
  return mine.name;
}

/** A usable token, refreshed when it is within a month of expiring. */
export async function token(dataDir: string): Promise<string> {
  const c = readCloud(dataDir);
  if (!c)
    throw new Error(
      "Not signed in to Bambu. The approver can sign in with makerworld_login (an emailed code).",
    );
  if (c.expiresMs && c.expiresMs - Date.now() < 30 * 24 * 3600_000 && c.refreshToken) {
    const r = await call("/v1/user-service/user/refreshtoken", {
      body: { refreshToken: c.refreshToken },
    });
    const fresh = String(r.json.accessToken ?? "");
    if (fresh) {
      saveCloud(dataDir, {
        ...c,
        accessToken: fresh,
        refreshToken: String(r.json.refreshToken ?? c.refreshToken),
        expiresMs: Date.now() + Number(r.json.expiresIn ?? 0) * 1000,
      });
      return fresh;
    }
  }
  if (c.expiresMs && c.expiresMs < Date.now()) {
    throw new Error(
      "The Bambu sign-in has expired. The approver can sign in again with makerworld_login.",
    );
  }
  return c.accessToken;
}

export type SearchHit = {
  id: number;
  title: string;
  url: string;
  cover: string;
  creator: string;
  likes: number;
  downloads: number;
  prints: number;
  license: string;
  tags: string[];
};

export const SORTS = ["score", "hotScore", "downloadCount", "likeCount", "newUploads"] as const;

export async function search(
  query: string,
  opts: { limit?: number; offset?: number; sort?: string } = {},
): Promise<{
  total: number;
  hits: SearchHit[];
}> {
  const q = new URLSearchParams({
    keyword: query,
    limit: String(Math.min(20, opts.limit ?? 8)),
    offset: String(opts.offset ?? 0),
  });
  if (opts.sort && opts.sort !== "score") q.set("orderBy", opts.sort);
  const r = await call(`/v1/search-service/select/design2?${q}`);
  if (r.status !== 200) throw new Error(`MakerWorld search failed (${r.status})`);
  const hits = (Array.isArray(r.json.hits) ? r.json.hits : []) as Array<Record<string, unknown>>;
  return {
    total: Number(r.json.total ?? 0),
    hits: hits.map((h) => ({
      id: Number(h.id),
      title: String(h.title ?? ""),
      url: `https://makerworld.com/en/models/${h.id}`,
      cover: String(h.cover ?? ""),
      creator: String((h.designCreator as Record<string, unknown> | undefined)?.name ?? ""),
      likes: Number(h.likeCount ?? 0),
      downloads: Number(h.downloadCount ?? 0),
      prints: Number(h.printCount ?? 0),
      license: String(h.license ?? ""),
      tags: (Array.isArray(h.tags) ? h.tags : []).map(String).slice(0, 8),
    })),
  };
}

export type ProfileSummary = {
  id: number;
  title: string;
  printer: string;
  forP2S: boolean;
  layerHeight: string;
  plates: Array<{
    index: number;
    minutes: number;
    grams: number;
    filaments: Array<{ type: string; color: string; grams: number }>;
  }>;
};

export type Design = {
  id: number;
  title: string;
  url: string;
  summary: string;
  license: string;
  allowRemix: boolean;
  creator: string;
  categories: string[];
  tags: string[];
  likes: number;
  downloads: number;
  prints: number;
  pictures: string[];
  defaultProfile: number;
  profiles: ProfileSummary[];
};

export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/h\d|\/li)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A model id from an id, a makerworld.com link, or a link with a profile anchor. */
export function designId(input: string | number): number | null {
  if (typeof input === "number") return input;
  const m = String(input).match(/models\/(\d+)/) ?? String(input).match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function design(id: number): Promise<Design> {
  const r = await call(`/v1/design-service/design/${id}`);
  if (r.status !== 200 || !r.json.id) throw new Error(`No MakerWorld model ${id} (${r.status})`);
  const d = r.json;
  const ext = (d.designExtension ?? {}) as { design_pictures?: Array<{ url?: string }> };
  const instances = (Array.isArray(d.instances) ? d.instances : []) as Array<
    Record<string, unknown>
  >;
  const profiles = instances.map((i): ProfileSummary => {
    const info = ((i.extention as Record<string, unknown> | undefined)?.modelInfo ?? {}) as Record<
      string,
      unknown
    >;
    const compat = (info.compatibility ?? {}) as { devModelName?: string; devProductName?: string };
    const others = (
      Array.isArray(info.otherCompatibility) ? info.otherCompatibility : []
    ) as Array<{ devModelName?: string }>;
    const plates = (Array.isArray(info.plates) ? info.plates : []) as Array<
      Record<string, unknown>
    >;
    const settings = (info.projectSettings ?? {}) as { layerHeight?: string };
    return {
      id: Number(i.id),
      title: String(i.title ?? ""),
      printer: String(compat.devProductName ?? ""),
      forP2S: compat.devModelName === P2S_MODEL || others.some((o) => o.devModelName === P2S_MODEL),
      layerHeight: String(settings.layerHeight ?? ""),
      plates: plates.map((p) => ({
        index: Number(p.index ?? 0),
        minutes: Math.round(Number(p.prediction ?? 0) / 60),
        grams: Number(p.weight ?? 0),
        filaments: (
          (Array.isArray(p.filaments) ? p.filaments : []) as Array<Record<string, unknown>>
        ).map((f) => ({
          type: String(f.type ?? ""),
          color: String(f.color ?? ""),
          grams: Number(f.usedG ?? 0),
        })),
      })),
    };
  });
  return {
    id: Number(d.id),
    title: String(d.title ?? ""),
    url: `https://makerworld.com/en/models/${d.id}`,
    summary: stripHtml(String(d.summary ?? "")).slice(0, 2000),
    license: String(d.license ?? ""),
    allowRemix: d.allowReCreation === true,
    creator: String((d.designCreator as Record<string, unknown> | undefined)?.name ?? ""),
    categories: ((Array.isArray(d.categories) ? d.categories : []) as Array<{ name?: string }>).map(
      (c) => String(c.name ?? ""),
    ),
    tags: (Array.isArray(d.tags) ? d.tags : []).map(String).slice(0, 15),
    likes: Number(d.likeCount ?? 0),
    downloads: Number(d.downloadCount ?? 0),
    prints: Number(d.printCount ?? 0),
    pictures: [
      String(d.coverUrl ?? ""),
      ...(ext.design_pictures ?? []).map((p) => String(p.url ?? "")),
    ]
      .filter(Boolean)
      .filter((u, i, a) => a.indexOf(u) === i),
    defaultProfile: Number(d.defaultInstanceId ?? 0),
    profiles,
  };
}

/** Download one print profile's project file. */
export async function downloadProfile(
  dataDir: string,
  profileId: number,
  outPath: string,
): Promise<string> {
  const t = await token(dataDir);
  const r = await call(`/v1/design-service/instance/${profileId}/f3mf?type=download`, { token: t });
  const url = String(r.json.url ?? "");
  if (!url)
    throw new Error(
      `MakerWorld would not give the file (${r.status}): ${String(r.json.error ?? r.text).slice(0, 200)}`,
    );
  const file = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!file.ok) throw new Error(`Download failed (${file.status})`);
  writeFileSync(outPath, Buffer.from(await file.arrayBuffer()));
  return String(r.json.name ?? "");
}

/**
 * Fetch a picture and shrink it to `maxPx` on its long side as a JPEG, so it
 * can be looked at and texted (MakerWorld covers run to several megabytes).
 */
export async function fetchPicture(url: string, outPath: string, maxPx = 1280): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`picture ${res.status}`);
  const raw = `${outPath}.src`;
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  const r = spawnSync(
    "/usr/bin/sips",
    ["-s", "format", "jpeg", "-Z", String(maxPx), raw, "--out", outPath],
    {
      encoding: "utf8",
    },
  );
  spawnSync("/bin/rm", ["-f", raw]);
  if (r.status !== 0 || !existsSync(outPath)) throw new Error("could not convert the picture");
  return outPath;
}
