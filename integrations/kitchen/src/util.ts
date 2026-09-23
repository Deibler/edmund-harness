/** Small shared helpers. Anything domain-specific belongs in its own module. */

import { isAbsolute, resolve, sep } from "node:path";

const ENT: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape for HTML text and attribute contexts; item names come from receipts. */
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENT[c]!);
}

export function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Whether a string is a legitimate id and therefore safe in a filename.
 *
 * Ids are `slug()` output: lowercase letters, digits and dashes. Anything else
 * is rejected rather than sanitised, so "../../config" never becomes "config".
 */
export function safeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
}

/**
 * Resolve `rel` inside `root`, or return null.
 *
 * `join` alone walks out through "..", and some of these paths arrive from the
 * public callback endpoint. `prefix` narrows the allowed area to one
 * subdirectory, since "inside the artifact" is still the whole served site.
 */
export function contained(root: string, rel: unknown, prefix?: string): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  if (isAbsolute(rel)) return null;
  if (prefix && !`${rel}/`.startsWith(`${prefix.replace(/\/$/, "")}/`)) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** A finite positive number, or null. For values that arrive from a browser. */
export function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Pretty-print for tool output: aligned, no trailing whitespace. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (!all.length) return "";
  const w = all[0]!.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (c ?? "").padEnd(w[i]!))
      .join("  ")
      .trimEnd();
  return (headers ? [line(headers), w.map((n) => "-".repeat(n)).join("  ")] : [])
    .concat(rows.map(line))
    .join("\n");
}
