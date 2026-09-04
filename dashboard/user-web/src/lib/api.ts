import type { PortalPageData } from "@/types";

/**
 * The link IS the credential: /u/<key>/<token>. Every request goes under
 * that path, so the base is simply where the page was opened.
 */
export function basePath(): string {
  const m = location.pathname.match(/^\/u\/[^/]+\/[^/]+/);
  return m ? m[0] : location.pathname.replace(/\/+$/, "");
}

export class PortalError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function loadPage(): Promise<PortalPageData> {
  const res = await fetch(`${basePath()}/data`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new PortalError(
      res.status === 404 ? "This link is no longer valid." : `Could not load (${res.status}).`,
      res.status,
    );
  }
  return (await res.json()) as PortalPageData;
}

export type PostResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export async function post<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<PostResult<T>> {
  try {
    const res = await fetch(`${basePath()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: (json.error as string | undefined) ?? "request failed" };
    }
    return { ok: true, ...(json as T) };
  } catch {
    return { ok: false, error: "network error" };
  }
}

export function fileUrl(rel: string, download = false): string {
  return `${basePath()}/file?p=${encodeURIComponent(rel)}${download ? "&dl=1" : ""}`;
}
