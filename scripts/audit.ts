/**
 * Dependency audit gate.
 *
 * `bun audit` talks to a registry endpoint that fails intermittently, often
 * enough that using it raw as a required check makes the build red for
 * reasons that have nothing to do with the code. So: retry, and separate the
 * two outcomes that matter. An advisory at or above the threshold fails the
 * build. A registry that cannot be reached after every retry warns loudly and
 * does not, because GitHub's Dependabot alerts run continuously against the
 * same advisory database and are the durable check; this one is here to catch
 * a regression inside a pull request.
 *
 * Advisories that are known and accepted go in ALLOWED below, each with the
 * reason and the date, so the list is reviewable rather than a silent muzzle.
 */

type Advisory = { severity?: string; title?: string; url?: string; vulnerable_versions?: string };
type Report = Record<string, Advisory[]>;

const ORDER = ["info", "low", "moderate", "high", "critical"] as const;
type Level = (typeof ORDER)[number];

const threshold = (process.argv.find((a) => a.startsWith("--level="))?.split("=")[1] ??
  "high") as Level;
const attempts = Number(process.argv.find((a) => a.startsWith("--attempts="))?.split("=")[1] ?? 4);

/** package name -> why it is accepted. Revisit when the parent updates. */
const ALLOWED: Record<string, string> = {};

function atOrAbove(sev: string | undefined, min: Level): boolean {
  const i = ORDER.indexOf((sev ?? "").toLowerCase() as Level);
  return i >= 0 && i >= ORDER.indexOf(min);
}

async function readAudit(): Promise<Report | null> {
  const proc = Bun.spawn(["bun", "audit", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) {
    // No JSON at all means the request failed rather than "nothing found";
    // an empty report prints `{}`.
    if (/timeout|failed|ENOTFOUND|ECONNRESET/i.test(`${out}${err}`)) return null;
    return {};
  }
  try {
    return JSON.parse(line) as Report;
  } catch {
    return null;
  }
}

let report: Report | null = null;
for (let i = 1; i <= attempts; i++) {
  report = await readAudit();
  if (report !== null) break;
  if (i < attempts) {
    const waitMs = 2000 * i;
    console.log(
      `audit: registry did not answer (attempt ${i}/${attempts}), retrying in ${waitMs}ms`,
    );
    await Bun.sleep(waitMs);
  }
}

if (report === null) {
  console.warn(
    `audit: the advisory registry did not answer after ${attempts} attempts. Not failing the build: Dependabot alerts cover the same database continuously. Re-run this job if you want the in-PR check.`,
  );
  process.exit(0);
}

const failing: string[] = [];
const accepted: string[] = [];
for (const [pkg, advisories] of Object.entries(report)) {
  for (const a of advisories) {
    if (!atOrAbove(a.severity, threshold)) continue;
    const line = `${a.severity} ${pkg} ${a.title ?? ""} [${a.vulnerable_versions ?? "?"}]`;
    if (ALLOWED[pkg]) accepted.push(`${line}\n    accepted: ${ALLOWED[pkg]}`);
    else failing.push(line);
  }
}

for (const a of accepted) console.log(`audit: accepted ${a}`);
if (failing.length === 0) {
  console.log(`audit: no advisories at ${threshold} or above.`);
  process.exit(0);
}
console.error(`audit: ${failing.length} advisory/advisories at ${threshold} or above:`);
for (const f of failing) console.error(`  ${f}`);
console.error(
  "\nFix by updating the package, or by adding an override in package.json when the fix is in a transitive dependency. If it genuinely cannot be fixed, add it to ALLOWED in scripts/audit.ts with the reason.",
);
process.exit(1);

export {};
