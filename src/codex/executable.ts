import { spawnSync } from "node:child_process";
import { findBins } from "../claude/mcp-config.ts";

export const MIN_CODEX_CLI_VERSION = "0.147.0";

type Version = readonly [major: number, minor: number, patch: number];

type CodexInstallation = {
  path: string;
  version: string;
  compatible: boolean;
};

let cachedInstallations: CodexInstallation[] | undefined;

/** Parse output such as `codex-cli 0.147.0`. */
export function parseCodexVersion(output: string): Version | null {
  const match = output.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=$|[+\s-])/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Inspect every installed Codex CLI once. A daemon often has several npm
 * prefixes (Homebrew, /usr/local, nvm); PATH order alone can silently select
 * an obsolete CLI even when a current one is installed.
 */
function codexInstallations(): CodexInstallation[] {
  if (cachedInstallations) return cachedInstallations;
  const minimum = parseCodexVersion(MIN_CODEX_CLI_VERSION)!;
  cachedInstallations = findBins("codex")
    .map((path) => {
      const result = spawnSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const parsed = parseCodexVersion(output);
      return {
        path,
        version: parsed ? parsed.join(".") : output || "unknown",
        compatible: parsed !== null && compareVersions(parsed, minimum) >= 0,
        parsed,
      };
    })
    .sort((a, b) => {
      if (a.parsed && b.parsed) return compareVersions(b.parsed, a.parsed);
      if (a.parsed) return -1;
      if (b.parsed) return 1;
      return 0;
    })
    .map(({ parsed: _parsed, ...installation }) => installation);
  return cachedInstallations;
}

/** Select the newest CLI that supports the runner's strict exec flags. */
export function codexExecutable(): string {
  const installations = codexInstallations();
  const selected = installations.find((installation) => installation.compatible);
  if (selected) return selected.path;
  if (installations.length === 0) {
    throw new Error(
      `Codex CLI not found; install @openai/codex >= ${MIN_CODEX_CLI_VERSION} and log in`,
    );
  }
  const found = installations.map(({ path, version }) => `${path} (${version})`).join(", ");
  throw new Error(
    `Codex CLI >= ${MIN_CODEX_CLI_VERSION} is required; incompatible install${installations.length === 1 ? "" : "s"} found: ${found}`,
  );
}

/** Used by the boot loadout check without throwing. */
export function codexCompatibilityWarning(): string | null {
  const installations = codexInstallations();
  if (installations.some((installation) => installation.compatible)) return null;
  if (installations.length === 0) {
    return `Codex CLI not found; install @openai/codex >= ${MIN_CODEX_CLI_VERSION}`;
  }
  const found = installations.map(({ path, version }) => `${version} at ${path}`).join(", ");
  return `Codex CLI >= ${MIN_CODEX_CLI_VERSION} is required; found ${found}`;
}
