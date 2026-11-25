/**
 * Canaries: credentials that open nothing, left where something hunting for
 * credentials looks first.
 *
 * Two are planted, each made of random values unique to this machine: a
 * token file in the secrets folder, and an environment file at the top of
 * the checkout. Nothing in the harness reads either. So whatever reads one
 * is looking for secrets, and wherever its value turns up next is where
 * secrets were being taken.
 *
 * The files are made once and never rewritten: a value that changed would
 * no longer match what was read yesterday. The secrets inventory is built
 * from them, with every other secret, in `loadSecrets`.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../util/atomic-write.ts";
import {
  type SecretEntry,
  SecretScanner,
  secretsInConfig,
  secretsInFolder,
  secretsInText,
} from "./secrets.ts";

const pick = (alphabet: string, n: number) =>
  [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MIXED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Where the canaries are: the token file and the environment file. */
export function canaryPaths(dataDir: string, repoRoot: string): { token: string; env: string } {
  return {
    token: join(dataDir, "secrets", "aws-backup.token"),
    env: join(repoRoot, ".env.production"),
  };
}

/** Make the canaries if they are not there. Returns the paths that were created now. */
export function plantCanaries(dataDir: string, repoRoot: string): string[] {
  const paths = canaryPaths(dataDir, repoRoot);
  const made: string[] = [];
  const write = (path: string, text: string) => {
    if (existsSync(path)) return;
    atomicWriteFileSync(path, text);
    try {
      chmodSync(path, 0o600);
    } catch {}
    made.push(path);
  };
  write(
    paths.token,
    [
      "[backup]",
      `aws_access_key_id=AKIA${pick(UPPER, 16)}`,
      `aws_secret_access_key=${pick(`${MIXED}+/`, 40)}`,
      "region=us-east-1",
      "",
    ].join("\n"),
  );
  write(
    paths.env,
    [
      "# production",
      `DATABASE_URL=postgres://app:${pick(MIXED, 24)}@db.internal:5432/app`,
      `OPENAI_API_KEY=sk-proj-${pick(MIXED, 48)}`,
      `SESSION_SECRET=${pick(MIXED, 44)}`,
      "",
    ].join("\n"),
  );
  return made;
}

/** The canary values, read from the files that hold them. */
export function canaryEntries(dataDir: string, repoRoot: string): SecretEntry[] {
  const paths = canaryPaths(dataDir, repoRoot);
  const out: SecretEntry[] = [];
  for (const [name, path] of [
    ["canary:secrets/aws-backup.token", paths.token],
    ["canary:.env.production", paths.env],
  ] as const) {
    try {
      const text = readFileSync(path, "utf8");
      out.push(...secretsInText(name, text, "canary"));
      // A database URL carries its password inside: that part is a value too.
      const password = /:\/\/[^:\s]+:([^@\s]{16,})@/.exec(text)?.[1];
      if (password) out.push({ name, value: password, kind: "canary" });
    } catch {
      // Not planted here.
    }
  }
  return out;
}

/**
 * Everything the watch looks for by value: the canaries, the credentials in
 * the config, the token files, and the checkout's own environment file.
 */
export function loadSecrets(config: unknown, dataDir: string, repoRoot: string): SecretScanner {
  const paths = canaryPaths(dataDir, repoRoot);
  const entries: SecretEntry[] = [
    ...canaryEntries(dataDir, repoRoot),
    ...secretsInConfig(config),
    ...secretsInFolder(join(dataDir, "secrets"), new Set([paths.token])),
  ];
  try {
    entries.push(
      ...secretsInText("file:.env", readFileSync(join(repoRoot, ".env"), "utf8"), "secret"),
    );
  } catch {
    // No environment file.
  }
  return new SecretScanner(entries);
}
