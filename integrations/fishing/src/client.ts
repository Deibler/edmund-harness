import type { Config } from "../../../src/config/config.ts";
/**
 * Thin HTTP client for the local mid-Atlantic fishing data platform
 * (FastAPI, default http://127.0.0.1:8087/api/v1). Used by the fishing MCP
 * tools. Two shapes: JSON (data + viz json/csv) and image (viz png/svg).
 */
import { fishingConfig } from "../config.ts";

export function fishingBaseUrl(config?: Config): string {
  const url =
    (config ? fishingConfig(config).api_url : "") ||
    process.env.FISHING_API_URL ||
    "http://127.0.0.1:8087/api/v1";
  return url.replace(/\/+$/, "");
}

function buildUrl(base: string, path: string, params?: Record<string, unknown>): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(base + p);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function get(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type JsonResult = { ok: boolean; status: number; url: string; body: unknown };

export async function fishingGetJson(
  base: string,
  path: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<JsonResult> {
  const url = buildUrl(base, path, params);
  const res = await get(url, timeoutMs);
  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* keep raw text (e.g. csv / markdown) */
  }
  return { ok: res.ok, status: res.status, url, body };
}

export type ImageResult = {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  base64?: string;
  text?: string;
};

export async function fishingGetImage(
  base: string,
  path: string,
  params?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<ImageResult> {
  const url = buildUrl(base, path, params);
  const res = await get(url, timeoutMs);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, url, contentType, base64: buf.toString("base64") };
  }
  return { ok: res.ok, status: res.status, url, contentType, text: await res.text() };
}
