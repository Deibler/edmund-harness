/**
 * Minimal GNU-ish arg parser. No deps.
 *
 *   edmund start --harness --dashboard --local
 *   edmund logs --error --follow
 *   edmund cron delete job_abc123
 *
 * Positional args (no leading `-`) are returned in `positional`. Long flags
 * (`--name`) and short flags (`-n`) become true when present and can take a
 * value with `--name=foo` or `--name foo`. Short-flag bundling is not
 * supported (we don't need it).
 */

export type Parsed = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    // `noUncheckedIndexedAccess` types this as `string | undefined` even though
    // the loop bound guarantees it — skip rather than assert, so a sparse argv
    // (never produced by Bun, but cheap to tolerate) can't throw.
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function getFlag(p: Parsed, ...names: string[]): string | boolean | undefined {
  for (const n of names) {
    if (n in p.flags) return p.flags[n];
  }
  return undefined;
}

export function hasFlag(p: Parsed, ...names: string[]): boolean {
  return names.some((n) => n in p.flags);
}

export function getString(p: Parsed, ...names: string[]): string | undefined {
  const v = getFlag(p, ...names);
  return typeof v === "string" ? v : undefined;
}
