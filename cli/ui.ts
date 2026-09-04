/**
 * Tiny terminal UI helpers. No deps — just ANSI.
 *
 * - Respects NO_COLOR and non-TTY stdout by degrading to plain text.
 * - `box`, `row`, and `kv` are the three primitives every command uses so
 *   output stays visually consistent across the CLI.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function c(code: number) {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const color = {
  dim: c(2),
  bold: c(1),
  red: c(31),
  green: c(32),
  yellow: c(33),
  blue: c(34),
  magenta: c(35),
  cyan: c(36),
  white: c(37),
  gray: c(90),
  bgRed: c(41),
  bgGreen: c(42),
};

const icons = {
  ok: color.green("✓"),
  fail: color.red("✗"),
  warn: color.yellow("▲"),
  info: color.blue("›"),
  dot: color.dim("·"),
  arrow: color.cyan("→"),
  bullet: color.gray("•"),
};

function title(s: string): void {
  print(color.bold(s));
}

export function section(s: string): void {
  print("");
  print(color.bold(color.white(s)));
  print(color.dim("─".repeat(Math.min(s.length, 60))));
}

export function kv(
  key: string,
  value: string | number | boolean | null | undefined,
  width = 18,
): void {
  const v = value === null || value === undefined ? color.dim("—") : String(value);
  print(`  ${color.dim(key.padEnd(width))}${v}`);
}

/** Compact status badge. */
export function badge(
  text: string,
  tone: "ok" | "warn" | "fail" | "muted" | "info" = "muted",
): string {
  const map = {
    ok: color.green,
    warn: color.yellow,
    fail: color.red,
    muted: color.dim,
    info: color.cyan,
  };
  return map[tone](text);
}

/**
 * Fixed-column table. Values are strings — the caller pre-colors them. Column
 * widths are computed from the widest row.
 */
export function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const sep = color.dim("  ");
  print(color.bold(headers.map((h, i) => pad(h, widths[i] ?? 0)).join(sep)));
  print(color.dim(widths.map((w) => "─".repeat(w)).join("──")));
  for (const r of rows) {
    print(r.map((cell, i) => pad(cell ?? "", widths[i] ?? 0)).join(sep));
  }
}

export function ok(msg: string): void {
  print(`${icons.ok} ${msg}`);
}

export function fail(msg: string): void {
  print(`${icons.fail} ${color.red(msg)}`);
}

export function info(msg: string): void {
  print(`${icons.info} ${color.dim(msg)}`);
}

export function warn(msg: string): void {
  print(`${icons.warn} ${color.yellow(msg)}`);
}

export function print(msg = ""): void {
  process.stdout.write(`${msg}\n`);
}

export function hr(): void {
  print(color.dim("─".repeat(60)));
}

/** Visible length ignoring ANSI escape sequences. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number): string {
  const gap = width - visibleLen(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}
