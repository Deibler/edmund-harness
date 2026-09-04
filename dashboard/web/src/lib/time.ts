export function relativeTime(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  const future = delta < 0;
  const units: Array<[number, string]> = [
    [60_000, "s"],
    [3_600_000, "m"],
    [86_400_000, "h"],
    [7 * 86_400_000, "d"],
  ];
  let value = 0;
  let unit = "s";
  if (abs < 60_000) {
    value = Math.max(1, Math.round(abs / 1000));
  } else if (abs < units[1][0]) {
    value = Math.round(abs / 60_000);
    unit = "m";
  } else if (abs < units[2][0]) {
    value = Math.round(abs / 3_600_000);
    unit = "h";
  } else if (abs < units[3][0]) {
    value = Math.round(abs / 86_400_000);
    unit = "d";
  } else {
    const weeks = Math.round(abs / (7 * 86_400_000));
    value = weeks;
    unit = "w";
  }
  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

export function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtTimeFull(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}
