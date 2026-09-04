/** Shared helpers. Small on purpose — anything domain-shaped belongs in a real module. */

import { isAbsolute, resolve, sep } from "node:path";

const ENT: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape for HTML text and attribute contexts. Item names come from receipts. */
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENT[c]!);
}

export function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Is this string safe to put in a filename?
 *
 * Ids in this integration are `slug()` output — lowercase, digits, dashes, with
 * a double dash marking a variant. Nothing else is legitimate, so anything else
 * is rejected rather than sanitised: a caller passing "../../config" wants
 * something, and quietly rewriting it into "config" grants a worse version of
 * the same wish.
 */
export function safeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
}

/**
 * Resolve `rel` inside `root`, or refuse.
 *
 * `join(root, rel)` is not containment — it happily walks out through "..", and
 * the callback endpoint that supplies some of these paths accepts any JSON
 * object from anybody holding the page link. A move whose source is chosen by
 * the caller is both a read of that file and a delete of it, so this is checked
 * rather than assumed.
 *
 * `prefix` narrows it further to the one directory a given caller is allowed to
 * name, because "inside the artifact" is still the whole served website.
 */
export function contained(root: string, rel: unknown, prefix?: string): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  if (isAbsolute(rel)) return null;
  if (prefix && !`${rel}/`.startsWith(`${prefix.replace(/\/$/, "")}/`)) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** A finite positive number, or nothing. Anything a browser sent needs this. */
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
