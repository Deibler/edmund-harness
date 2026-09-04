/**
 * Typed fetch wrapper. Throws ApiError on non-2xx; auth errors redirect to
 * /login via a custom event the AuthContext listens for.
 */

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

export async function api<T>(
  path: string,
  opts: { method?: Method; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = "GET", body, signal } = opts;
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("edh:unauthorized"));
  }
  const text = await res.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (payload as { error?: string; detail?: string } | undefined) ?? {};
    throw new ApiError(err.error ?? `HTTP ${res.status}`, res.status, err.detail);
  }
  return payload as T;
}
