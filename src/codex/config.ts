import { existsSync, readFileSync } from "node:fs";

type JsonMcpServer = {
  type?: string;
  command?: string;
  args?: unknown[];
  env?: Record<string, unknown>;
  cwd?: string;
  url?: string;
  headers?: Record<string, unknown>;
  http_headers?: Record<string, unknown>;
  bearer_token_env_var?: string;
  enabled_tools?: unknown[];
  disabled_tools?: unknown[];
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};

type JsonMcpConfig = { mcpServers?: Record<string, JsonMcpServer> };

const HARNESS_MCP_ENV_VARS = [
  "EDMUND_CONFIG_PATH",
  "EDMUND_SESSION_KEY",
  "EDMUND_INBOUND_DEPTH",
  "EDMUND_SESSION_TIER",
  "EDMUND_AGENT_MODEL",
  "EDMUND_AGENT_EFFORT",
  "EDMUND_CONTEXT_WINDOW_TOKENS",
  "EDMUND_AGENT",
  "EDMUND_SENDER_HANDLE",
  "EDMUND_BRIDGE_SOCK",
  "EDMUND_OPENAI_KEY",
  "EDMUND_GEMINI_KEY",
  "EDMUND_ELEVENLABS_KEY",
  "EDMUND_SANDBOX_PATH",
  "EDMUND_DATA_DIR",
  "INSTANT_SHARE_CONFIG_DIR",
  "INSTANT_SHARE_ARTIFACT_DIR",
  "INSTANT_SHARE_ADMIN_PASSWORD",
];

/**
 * First-party MCP servers that run from this repository and are invoked from
 * non-interactive Codex exec sessions. `approval_policy="never"` cannot answer
 * an `auto` approval prompt, so leaving either server on auto silently cancels
 * its state-changing tools. Third-party/integration servers remain on auto.
 */
const TRUSTED_LOCAL_MCP_SERVERS = new Set(["edmund-harness", "ghost"]);

/**
 * Translate Claude Code's JSON MCP bundle into one isolated Codex config
 * override. The harness keeps owning the server list; Codex never inherits
 * unrelated servers from the operator's global configuration.
 */
export function codexMcpConfigArgs(pathOrJson: string): string[] {
  const source = existsSync(pathOrJson) ? readFileSync(pathOrJson, "utf8") : pathOrJson;
  let parsed: JsonMcpConfig;
  try {
    parsed = JSON.parse(source) as JsonMcpConfig;
  } catch (err) {
    throw new Error(`invalid MCP config for Codex: ${(err as Error).message}`);
  }

  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    const server: Record<string, unknown> = {};
    if (typeof raw.command === "string" && raw.command) {
      server.command = raw.command;
      if (Array.isArray(raw.args)) server.args = raw.args.map(String);
      if (raw.env && typeof raw.env === "object") server.env = stringMap(raw.env);
      if (typeof raw.cwd === "string" && raw.cwd) server.cwd = raw.cwd;
      if (name === "edmund-harness") server.env_vars = HARNESS_MCP_ENV_VARS;
    } else if (typeof raw.url === "string" && raw.url) {
      server.url = raw.url;
      const headers = raw.http_headers ?? raw.headers;
      if (headers && typeof headers === "object") server.http_headers = stringMap(headers);
      if (typeof raw.bearer_token_env_var === "string") {
        server.bearer_token_env_var = raw.bearer_token_env_var;
      }
    } else {
      throw new Error(`MCP server "${name}" has neither command nor url`);
    }

    if (Array.isArray(raw.enabled_tools)) server.enabled_tools = raw.enabled_tools.map(String);
    if (Array.isArray(raw.disabled_tools)) server.disabled_tools = raw.disabled_tools.map(String);
    if (typeof raw.startup_timeout_sec === "number") {
      server.startup_timeout_sec = raw.startup_timeout_sec;
    }
    if (typeof raw.tool_timeout_sec === "number") server.tool_timeout_sec = raw.tool_timeout_sec;
    const trustedLocal = TRUSTED_LOCAL_MCP_SERVERS.has(name);
    server.required = trustedLocal;
    // Codex runs non-interactively, and exec mode cannot surface approval
    // prompts at all. In `auto` mode, side-effecting MCP calls such as
    // send_attachment are routed to an approval nobody can answer, so Codex
    // reports "user cancelled MCP tool call" without the request ever
    // reaching our server — the first live day's image sends and reminder
    // callbacks all died here. Harness tools already enforce their own
    // session/scope guards; the ghost server only writes its validated result
    // to the per-tick decision path. Pre-approve these first-party servers and
    // leave third-party servers on automatic review.
    server.default_tools_approval_mode = trustedLocal ? "approve" : "auto";
    servers[name] = server;
  }

  return ["-c", `mcp_servers=${tomlValue(servers)}`];
}

function stringMap(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

/** Serialize the JSON-shaped subset used above as a TOML inline value. */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`,
    );
    return `{ ${pairs.join(", ")} }`;
  }
  throw new Error(`unsupported TOML value: ${String(value)}`);
}
