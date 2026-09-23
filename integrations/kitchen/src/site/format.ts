/** Formatting helpers shared by the panels: dates, JSON embedding, images. */

import { DAY_NAME, SHORT_DAY, clock } from "../schedules.ts";
import { escapeHtml } from "../util.ts";

/** Up to two initials, for an item or dish with no photo. */
export const monogram = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** An image slot, or a monogram tile when there is no image. */
export function shot(src: string | null, alt: string, cls = ""): string {
  const inner = src
    ? `<img data-img="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`
    : `<div class="mono">${escapeHtml(monogram(alt))}</div>`;
  return `<div class="shot ${cls}">${inner}</div>`;
}

/** JSON safe to embed inside a `<script>` element. */
export const j = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/-->/g, "--\\>");

export const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

export const ago = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function daysLabel(days: number[]): string {
  if (!days.length || days.length === 7) return "Every day";
  if (days.length === 5 && days.every((d) => d >= 1 && d <= 5)) return "Weekdays";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "Weekends";
  return days.map((d) => SHORT_DAY[d]).join(" ");
}

/** "today at 4pm", "tomorrow at 4pm" or "Friday at 4pm". */
export function whenWord(d: Date): string {
  const now = new Date();
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  const t = clock(
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  );
  if (days === 0) return `today at ${t}`;
  if (days === 1) return `tomorrow at ${t}`;
  return `${DAY_NAME[d.getDay()]} at ${t}`;
}
