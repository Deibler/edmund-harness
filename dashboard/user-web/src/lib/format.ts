import type { Job } from "@/types";

export function fmtLocal(ms: number | null | undefined, tz: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function fmtDay(ms: number | null | undefined, tz: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(ms));
  } catch {
    return "—";
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
}

/** Cents matter for a generation: "$0.0686" under a dollar, "$3.20" above. */
export function moneyExact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

/** "Sep 2" — with the year once it is not this year. */
export function fmtDateShort(ms: number, tz: string): string {
  try {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(d);
  } catch {
    return "—";
  }
}

/** "12:43 PM" */
export function fmtTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "—";
  }
}

/** "12 PM" — when only the hour is known. */
export function fmtHour(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }).format(new Date(ms));
  } catch {
    return "—";
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const PORTAL_EVENT_PREFIX = "[PORTAL_SCHEDULE]";

/** Mirrors describeJob in the server view: a job in words a person recognises. */
export function describeJob(job: Job, tz: string): { title: string; when: string; mine: boolean } {
  const mine = job.systemEvent.startsWith(PORTAL_EVENT_PREFIX);
  let title: string;
  if (/^\[(BROWN_NOSE|GHOST)/.test(job.systemEvent) || /brown-nose/i.test(job.systemEvent)) {
    title = "Queued note from Edmund";
  } else if (mine) {
    const m = job.systemEvent.match(/"([\s\S]*)"/);
    title = m?.[1] ?? "Your scheduled task";
  } else {
    const cleaned = job.systemEvent.replace(/^\[[A-Z_]+\]/, "").trim();
    const head = cleaned.split("\n")[0] ?? cleaned;
    title = head.length > 140 ? `${head.slice(0, 139)}…` : head || "Scheduled task";
  }
  const when =
    job.schedule.kind === "once"
      ? `once, ${fmtLocal(job.schedule.atMs, tz)}`
      : `${cronWords(job.schedule.expr)}, next ${fmtLocal(job.nextFireMs, tz)}`;
  return { title, when, mine };
}

function cronWords(expr: string): string {
  const m = expr.match(/^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|\d)$/);
  if (!m) return `repeats (${expr})`;
  const [, min, hour, dow] = m;
  const t = (h: string) => {
    const hh = Number(h);
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  };
  if (hour === "*") return "every hour";
  if (dow === "*") return `daily at ${t(hour as string)}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `every ${days[Number(dow)]} at ${t(hour as string)}`;
}
