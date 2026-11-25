/**
 * What a tool call means, read from its name and arguments.
 *
 * The rules that decide whether a turn looks like an attack (tripwires.ts)
 * are written in terms of what was done: data could leave to this host, this
 * file was written, this message goes to that person. This turns a call into
 * those terms. It reads text and guesses nothing it cannot see: a command
 * that runs a script says only that the script ran, and the script's own
 * text is read when the turn writes it.
 *
 * The tool names are the ones the assistant was seen to use (2,467 calls
 * over the month to 2026-11-25: 966 `Bash`, 231 `Read`, the harness's own
 * tools, the browser, two outside servers). An unknown tool means nothing
 * here and is still written to the flight record.
 */
import { homedir } from "node:os";
import { hostsIn } from "./hosts.ts";

type Door = { kind: "tunnel" | "listener" | "publish"; detail: string };

export type Meaning = {
  /** Hosts the call names as somewhere to connect to. */
  hosts: string[];
  /** True when the call can carry data to those hosts, not only fetch from them. */
  canSend: boolean;
  /** Paths that hold credentials and that the call reads. */
  secretPaths: string[];
  /** Paths the call writes or changes that make something run again later. */
  persistence: string[];
  /** A message to people: who, and whether any of them is outside the current chat. */
  message: { text: string; recipients: string[]; outsideChat: boolean } | null;
  /** Fetched code run without being looked at, or a command hidden in an encoding. */
  exec: { pipeToShell: boolean; decoded: boolean; ran: string[] };
  /** Something that can be reached from outside is being opened. */
  door: Door | null;
  /** Files this call brings in from the network. */
  downloads: string[];
  /** True when what the call returns was written by someone else: a page, a file from outside. */
  readsUntrusted: boolean;
  /** True when what the call returns is a conversation's messages, which are outside content unless the conversation is the operator's own. */
  readsMessages: boolean;
  /** Everything the call sends or writes, as one text to scan for secrets. */
  outbound: string;
  /** One line for the record. */
  summary: string;
};

const HOME = homedir();

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function empty(summary: string): Meaning {
  return {
    hosts: [],
    canSend: false,
    secretPaths: [],
    persistence: [],
    message: null,
    exec: { pipeToShell: false, decoded: false, ran: [] },
    door: null,
    downloads: [],
    readsUntrusted: false,
    readsMessages: false,
    outbound: "",
    summary,
  };
}

const clip = (text: string, n = 160) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

// --- paths --------------------------------------------------------------------

/**
 * Where credentials live that the watch does not know by value: a path that
 * matches is a secret being read, whatever reads it. config.toml and the
 * secrets folder are not here on purpose. Their values are known, so a read
 * of one is seen exactly, in what the call returns (`recordResult`), and a
 * command that only names the file (`grep model config.toml`) is not
 * mistaken for one. Naming them cost a hold on 2026-11-12 in the replay.
 */
const SECRET_PATHS: [what: string, pattern: RegExp][] = [
  ["an ssh key", /\.ssh\/(?:id_[a-z0-9_]+|[^\s"'|;&)]*_(?:rsa|ed25519|ecdsa))(?![\w.]*\.pub)\b/],
  ["a .env file", /(?:^|[\s"'=/])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s"'|;&)])/],
  [
    "cloud credentials",
    /\.(?:aws\/credentials|netrc|npmrc|pypirc|docker\/config\.json|kube\/config|gnupg\/)/,
  ],
  ["the Claude login", /\.claude\/\.credentials\.json|\.codex\/auth\.json/],
  ["a tunnel credential", /\.cloudflared\/[^\s"'|;&)]*\.(?:json|pem)/],
  [
    "a token file",
    /[^\s"'|;&)/]*(?:token|secret|credential|apikey|api_key)[^\s"'|;&)/]*\.(?:txt|json|key|pem|token)\b/i,
  ],
  [
    "the keychain",
    /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain|export)\b|Library\/Keychains\//,
  ],
  ["browser logins", /(?:Cookies|Login Data|cookies\.sqlite|logins\.json)(?=$|[\s"'|;&)])/],
  ["a GitHub token", /\bgh\s+auth\s+token\b/],
];

function secretPathsIn(text: string): string[] {
  if (!text) return [];
  return SECRET_PATHS.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
}

/**
 * Where a change makes something run again later, or changes who is trusted.
 * These are the plan's list (2026-11-25) plus the three it missed that do the
 * same job: login items, git hooks and Claude Code's own settings.
 */
const PERSISTENCE_PATHS: [what: string, pattern: RegExp][] = [
  ["a LaunchAgent or LaunchDaemon", /Library\/Launch(?:Agents|Daemons)\b/],
  [
    "a shell profile",
    /(?:^|[\s"'=/~])\.(?:zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|profile)\b|\/etc\/(?:profile|zshrc|zprofile|paths)\b/,
  ],
  ["ssh access", /\.ssh\/(?:authorized_keys|config|rc)\b/],
  ["a cloudflared config", /\.cloudflared\/|\/etc\/cloudflared\b/],
  ["the assistant's standing instructions", /persona\/(?:AGENTS|SOUL|IDENTITY)\.md\b/],
  ["config.toml", /(?:^|[\s"'=/])config\.toml\b/],
  ["a git hook", /\.git\/hooks\//],
  ["Claude Code settings", /\.claude\/settings(?:\.local)?\.json\b/],
  ["sudoers", /\/etc\/sudoers/],
];

/** Commands that are persistence whatever file they touch. */
const PERSISTENCE_COMMANDS: [what: string, pattern: RegExp][] = [
  ["crontab", /\bcrontab\b(?!\s+-l\b)/],
  ["launchctl", /\blaunchctl\s+(?:load|bootstrap|enable|submit)\b/],
  ["a login item", /\bdefaults\s+write\b[^|;&]*(?:loginwindow|LoginItems|LoginHook)|login item/i],
  ["at job", /(?:^|[;&|]\s*)(?:at|batch)\s+(?:now|\d|-f)/],
];

const WRITE_VERB =
  /^(?:sudo\s+)?(?:cp|mv|ln|tee|install|rsync|rm|unlink|chmod|chown|touch|mkdir|truncate|dd|ed|ex|patch|plutil|defaults|launchctl|crontab|sed\s+(?:-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i|\/usr\/libexec\/PlistBuddy|PlistBuddy)\b/;

/**
 * The command without the bodies of its here-documents. A body is a file's
 * text or a script, not shell: an HTML line starting with `/` is not a
 * program being run. The rules about shell syntax read this; the rules about
 * where data goes read the whole command, body included.
 */
export function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let until: string | null = null;
  for (const line of lines) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) until = m[2]!;
  }
  return out.join("\n");
}

/** The simple commands of a line, split where the shell would start another one. */
function segments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||(?<![>&])\|(?!\|)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The targets of `>` and `>>` in one simple command. */
function redirectTargets(segment: string): string[] {
  return [...segment.matchAll(/(?<![0-9&<])>>?\s*("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map((m) =>
    m[1]!.replace(/^["']|["']$/g, ""),
  );
}

function persistenceIn(command: string): string[] {
  const found = new Set<string>();
  for (const [what, pattern] of PERSISTENCE_COMMANDS) if (pattern.test(command)) found.add(what);
  for (const segment of segments(command)) {
    const targets = redirectTargets(segment).join(" ");
    const writes = WRITE_VERB.test(segment);
    for (const [what, pattern] of PERSISTENCE_PATHS) {
      if (pattern.test(targets) || (writes && pattern.test(segment))) found.add(what);
    }
  }
  return [...found];
}

// --- the shell ----------------------------------------------------------------

/** A command that sends, as opposed to one that only fetches. */
const SENDS: RegExp[] = [
  /\bcurl\b[^|;&]*\s(?:-[a-zA-Z]*[dFT]\b|--data(?:-raw|-binary|-urlencode|-ascii)?\b|--form(?:-string)?\b|--upload-file\b|--json\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b)/i,
  /\bwget\b[^|;&]*--(?:post-(?:data|file)|body-(?:data|file)|method=(?:POST|PUT|PATCH))/i,
  /\b(?:http|https|xh)\s+(?:--form\s+|--json\s+)?(?:POST|PUT|PATCH)\b/,
  /\b(?:nc|ncat|netcat|socat|telnet)\b/,
  /\b(?:scp|sftp|rsync|ftp)\b[^|;&]*[a-z0-9._-]+@[a-z0-9.-]+:|\brsync\b[^|;&]*:\/|\bscp\b/i,
  /\bssh\b[^|;&]*\s[a-z0-9._-]*@?[a-z0-9.-]+\.[a-z]{2,}/i,
  /\bgit\s+push\b|\bgh\s+(?:gist\s+create|release\s+upload|repo\s+create)\b/,
  /\b(?:aws\s+s3\s+(?:cp|sync|mv)|gsutil\s+(?:cp|rsync|mv)|rclone\s+(?:copy|sync|move)|s3cmd\s+(?:put|sync)|az\s+storage\s+blob\s+upload)\b/,
  /\b(?:requests|httpx)\.(?:post|put|patch)\b|urllib\.request\.urlopen\([^)]*data=|\bfetch\([^)]*method:\s*["'](?:POST|PUT|PATCH)/i,
  /\bmail(?:x)?\s+-s\b|\bsendmail\b|\bosascript\b[^|;&]*\b(?:Mail|Messages)\b/,
];

/** Data carried in an address by the shell: a substitution where a host, path or query would be. */
const URL_SUBSTITUTION =
  /(?:https?:\/\/|@)[^\s"']*(?:\$\(|`|\$\{?[A-Za-z_])|\b(?:dig|nslookup|host|ping)\b[^|;&]*(?:\$\(|`)/;

/**
 * True when an address carries something that is not an address: a shell
 * substitution, or a long run that reads as encoded data. An article's slug
 * is long too; it is lower-case words joined by hyphens, and is not this.
 */
export function carriesPayload(text: string): boolean {
  if (URL_SUBSTITUTION.test(text)) return true;
  for (const m of text.matchAll(/https?:\/\/[^\s"']*/g)) {
    for (const run of m[0].matchAll(/[A-Za-z0-9+_=-]{64,}/g)) {
      const r = run[0];
      if (/^[0-9a-f]+$/i.test(r)) return true;
      const hyphens = (r.match(/-/g) ?? []).length;
      if (/[A-Z]/.test(r) && /[a-z]/.test(r) && /[0-9]/.test(r) && hyphens < 4) return true;
    }
  }
  return false;
}

const FETCHES = /\b(?:curl|wget|fetch|http|https|xh|aria2c)\b/;
const SHELLS = "(?:ba|z|k|da|a)?sh|python[0-9.]*|node|bun|deno|perl|ruby|php|osascript";

/**
 * An interpreter that takes its program from what is piped to it: nothing
 * after its name, or `-`, or `-s`. `curl … | python3 -c '…'` is the turn's
 * own program reading fetched data, which is ordinary; `curl … | sh` is the
 * fetched text being run. 18 of the first 25 trips in the replay were the
 * former.
 */
const FROM_STDIN = `(?:${SHELLS})(?:\\s+(?:-s\\b[^|;&\\n]*|-))?\\s*(?=$|[;&|)\\n])`;

const PIPE_TO_SHELL = new RegExp(
  [
    `(?:\\b(?:curl|wget|fetch|aria2c)\\b[^;&\\n]*\\|\\s*(?:sudo\\s+)?${FROM_STDIN})`,
    `(?:\\b(?:${SHELLS})\\s+(?:-c\\s+)?["']?\\$\\(\\s*(?:curl|wget)\\b)`,
    `(?:\\b(?:${SHELLS}|source|\\.)\\s+<\\(\\s*(?:curl|wget)\\b)`,
    `(?:\\beval\\s+["']?\\$\\(\\s*(?:curl|wget)\\b)`,
  ].join("|"),
  "m",
);

const DECODED_EXEC = new RegExp(
  [
    `(?:\\bbase64\\s+(?:-d|-D|--decode)\\b[^;&\\n]*\\|\\s*(?:sudo\\s+)?${FROM_STDIN})`,
    `(?:\\bxxd\\s+-r\\b[^;&\\n]*\\|\\s*(?:sudo\\s+)?${FROM_STDIN})`,
    `(?:\\beval\\s+["']?\\$\\([^)]*\\bbase64\\s+(?:-d|-D|--decode)\\b)`,
    `(?:\\bexec\\s*\\(\\s*(?:__import__\\(["']base64["']\\)|base64)\\.b64decode\\b)`,
    "(?:\\beval\\s*\\(\\s*atob\\b)",
  ].join("|"),
  "m",
);

const DOORS: [kind: Door["kind"], what: string, pattern: RegExp][] = [
  [
    "tunnel",
    "cloudflared tunnel",
    /\bcloudflared\b[^|;&]*\btunnel\b(?![^|;&]*\b(?:list|info|--help|version)\b)/,
  ],
  ["tunnel", "ngrok", /\bngrok\s+(?:http|tcp|tls|start)\b/],
  ["tunnel", "localtunnel", /\b(?:lt|localtunnel)\s+--port\b|\bnpx\s+localtunnel\b/],
  ["tunnel", "tailscale funnel", /\btailscale\s+(?:funnel|serve)\b/],
  ["tunnel", "ssh remote forward", /\bssh\b[^|;&]*\s-[A-Za-z]*R\b/],
  [
    "listener",
    "python http.server",
    /\bpython[0-9.]*\s+-m\s+http\.server\b(?![^|;&]*(?:--bind|-b)\s+(?:127\.0\.0\.1|localhost|::1))/,
  ],
  ["listener", "a static file server", /\b(?:npx|bunx)\s+(?:--yes\s+)?(?:http-server|serve)\b/],
  [
    "listener",
    "a listener on every interface",
    /(?:--host(?:name)?|--bind|--address|--listen|-b|-H)[\s=]+["']?(?:0\.0\.0\.0|::|\*)(?=[\s"':]|$)|\bphp\s+-S\s+0\.0\.0\.0/,
  ],
  ["listener", "netcat listening", /\b(?:nc|ncat|netcat)\b[^|;&]*\s-[a-zA-Z]*l/],
  ["listener", "socat listening", /\bsocat\b[^|;&]*(?:TCP|TCP4|TCP6|OPENSSL)-LISTEN/i],
];

/** Where a fetched file is put: `-o file`, `--output file`, `-O`, a clone's folder. */
function downloadsIn(command: string): string[] {
  const out: string[] = [];
  for (const segment of segments(command)) {
    if (!FETCHES.test(segment) && !/\bgit\s+clone\b|\bgh\s+repo\s+clone\b/.test(segment)) continue;
    for (const m of segment.matchAll(
      /(?:\s-o|\s--output|\s-O(?=\s+[^-h]))[\s=]+("[^"]+"|'[^']+'|[^\s;&|)]+)/g,
    )) {
      out.push(m[1]!.replace(/^["']|["']$/g, ""));
    }
    if (/\bcurl\b[^|;&]*\s-[a-zA-NP-Z]*O\b|\bwget\b(?![^|;&]*\s-O)/.test(segment)) {
      for (const m of segment.matchAll(
        /https?:\/\/[^\s"']+\/([^\s"'/?#]+)(?:[?#][^\s"']*)?(?=["'\s]|$)/g,
      )) {
        out.push(m[1]!);
      }
    }
    const clone =
      /\b(?:git\s+clone|gh\s+repo\s+clone)\b(?:\s+-{1,2}[^\s]+(?:\s+\d+)?)*\s+(\S+)(?:\s+([^\s;&|-][^\s;&|]*))?/.exec(
        segment,
      );
    if (clone) out.push(clone[2] ?? (clone[1]!.split("/").pop() ?? "").replace(/\.git$/, ""));
    if (/^(?:sudo\s+)?(?:curl|wget|aria2c)\b/.test(segment)) out.push(...redirectTargets(segment));
  }
  return [...new Set(out.filter(Boolean))];
}

const RUNNERS = new RegExp(
  `^(?:sudo\\s+)?(?:(?:${SHELLS}|source|\\.|open|installer|hdiutil|xattr|chmod)\\b|\\.\\/|\\/)`,
);

/** The files in `downloaded` that the command runs or prepares to run. */
function ranDownloads(command: string, downloaded: readonly string[]): string[] {
  if (downloaded.length === 0) return [];
  const out = new Set<string>();
  for (const segment of segments(command)) {
    if (!RUNNERS.test(segment)) continue;
    for (const file of downloaded) {
      // By the name it was saved under, as a word of the command.
      const base = file.split("/").pop() ?? file;
      if (base.length < 3) continue;
      const word = new RegExp(
        `(?:^|[\\s"'/=])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"';&|)])`,
      );
      if (word.test(segment)) out.add(file);
    }
  }
  return [...out];
}

function bashMeaning(command: string, downloaded: readonly string[]): Meaning {
  const m = empty(clip(command));
  const shell = withoutHeredocs(command);
  // A here-document is a file or a script: its URLs are places to go, its
  // email addresses are not, unless the command is one that sends mail.
  const mails = /\bapplication\s+"Mail"|\bmailx?\s+-s\b|\bsendmail\b/.test(command);
  m.hosts = [...new Set([...hostsIn(shell), ...hostsIn(command, !mails)])];
  m.canSend = m.hosts.length > 0 && (SENDS.some((p) => p.test(command)) || carriesPayload(command));
  m.secretPaths = secretPathsIn(shell);
  m.persistence = persistenceIn(shell);
  m.exec = {
    pipeToShell: PIPE_TO_SHELL.test(shell),
    decoded:
      DECODED_EXEC.test(shell) ||
      /\bexec\s*\(\s*(?:__import__\(["']base64["']\)|base64)\.b64decode\b|\beval\s*\(\s*atob\b/.test(
        command,
      ),
    ran: ranDownloads(shell, downloaded),
  };
  for (const [kind, what, pattern] of DOORS) {
    if (pattern.test(shell)) {
      m.door = { kind, detail: what };
      break;
    }
  }
  m.downloads = m.hosts.length > 0 ? downloadsIn(shell) : [];
  m.outbound = command;
  return m;
}

// --- the other tools -----------------------------------------------------------

const HARNESS = "mcp__edmund-harness__";

/** Tools whose answer is a page from the web. */
const WEB_READS = new Set([
  "WebFetch",
  "WebSearch",
  `${HARNESS}web_fetch`,
  `${HARNESS}web_search`,
  `${HARNESS}cf_markdown`,
  `${HARNESS}cf_content`,
  `${HARNESS}cf_snapshot`,
  `${HARNESS}cf_links`,
  `${HARNESS}cf_scrape`,
  `${HARNESS}cf_json`,
  `${HARNESS}cf_screenshot`,
  `${HARNESS}cf_pdf`,
  `${HARNESS}deep_research`,
]);

/** Tools whose answer is what other people wrote in a conversation. */
const MESSAGE_READS = new Set([
  `${HARNESS}search_history`,
  `${HARNESS}get_thread_context`,
  `${HARNESS}get_message`,
  `${HARNESS}semantic_search`,
  `${HARNESS}check_incoming`,
  `${HARNESS}catch_me_up`,
  `${HARNESS}list_attachments`,
]);

/** Where files that came from other people or from the network are kept. */
const OUTSIDE_FILES =
  /(?:received-(?:attachments|images|files)|\/Downloads\/|\/Attachments\/|sms-media\/|\/downloads?\/)/i;

function pathMeaning(
  tool: string,
  path: string,
  content: string,
  downloaded: readonly string[],
): Meaning {
  const expanded = path.replace(/^~(?=\/)/, HOME);
  const m = empty(`${tool} ${clip(path, 120)}`);
  const writing = tool !== "Read";
  if (writing) {
    for (const [what, pattern] of PERSISTENCE_PATHS)
      if (pattern.test(expanded)) m.persistence.push(what);
    // A script the turn writes is read for where it would go, as a command is.
    m.hosts = hostsIn(content, true);
    m.outbound = content;
  } else {
    m.secretPaths = secretPathsIn(expanded);
    const base = expanded.split("/").pop() ?? "";
    m.readsUntrusted =
      OUTSIDE_FILES.test(expanded) ||
      downloaded.some((d) => d === expanded || (d.split("/").pop() ?? d) === base);
  }
  return m;
}

/**
 * What one tool call means. `downloaded` is what the turn has brought in so
 * far, so that running or reading one of those files can be told apart from
 * running the assistant's own. `chatMembers` is who is in the conversation
 * the turn belongs to.
 */
export function meaningOf(
  tool: string,
  input: Record<string, unknown>,
  context: { downloaded?: readonly string[]; chatMembers?: readonly string[] } = {},
): Meaning {
  const downloaded = context.downloaded ?? [];
  if (tool === "Bash") return bashMeaning(str(input.command), downloaded);
  if (tool === "Read") return pathMeaning(tool, str(input.file_path), "", downloaded);
  if (tool === "Write")
    return pathMeaning(tool, str(input.file_path), str(input.content), downloaded);
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const text = `${str(input.new_string)}${str(input.new_source)}`;
    return pathMeaning(tool, str(input.file_path) || str(input.notebook_path), text, downloaded);
  }
  if (tool === "Glob" || tool === "Grep") {
    const m = empty(`${tool} ${clip(`${str(input.pattern)} ${str(input.path)}`, 120)}`);
    m.secretPaths = secretPathsIn(`${str(input.path)} ${str(input.glob)}`);
    return m;
  }

  if (WEB_READS.has(tool)) {
    const url = str(input.url);
    const m = empty(`${tool.replace(HARNESS, "")} ${clip(url || str(input.query), 140)}`);
    m.hosts = hostsIn(url);
    m.canSend = carriesPayload(url);
    m.readsUntrusted = true;
    m.outbound = `${url} ${str(input.prompt)} ${str(input.body)}`;
    return m;
  }

  if (tool.startsWith("mcp__chrome-devtools__") || tool.startsWith("mcp__computer-use__")) {
    const name = tool.split("__").pop() ?? tool;
    const url = str(input.url);
    const script = str(input.function) || str(input.script);
    const typed = str(input.text) || str(input.value);
    const m = empty(`browser ${name} ${clip(url || script || typed, 120)}`);
    m.hosts = hostsIn(`${url} ${script}`);
    // A script in a page can post anywhere; a form field goes where the page sends it.
    m.canSend = Boolean(script && m.hosts.length > 0) || carriesPayload(url);
    m.readsUntrusted = true;
    m.outbound = `${url} ${script} ${typed}`;
    return m;
  }

  if (tool.startsWith(HARNESS)) return harnessMeaning(tool.slice(HARNESS.length), input, context);

  return empty(`${tool} ${clip(JSON.stringify(input), 120)}`);
}

const sameHandle = (a: string, b: string) => {
  const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
  return a.includes("@") || b.includes("@")
    ? a.trim().toLowerCase() === b.trim().toLowerCase()
    : digits(a).length >= 7 && digits(a) === digits(b);
};

function harnessMeaning(
  name: string,
  input: Record<string, unknown>,
  context: { downloaded?: readonly string[]; chatMembers?: readonly string[] },
): Meaning {
  const members = context.chatMembers ?? [];
  const inChat = (handle: string) => members.some((m) => m === handle || sameHandle(m, handle));

  if (name === "send_message" || name === "send_location" || name === "react") {
    const text =
      `${str(input.text)} ${str(input.note)} ${str(input.address)} ${str(input.subject)}`.trim();
    const m = empty(`${name} ${clip(text, 100)}`);
    m.message = { text, recipients: [], outsideChat: false };
    m.outbound = text;
    return m;
  }
  if (name === "send_attachment") {
    const m = empty(`send_attachment ${clip(str(input.file_path), 120)}`);
    m.message = { text: str(input.caption), recipients: [], outsideChat: false };
    m.secretPaths = secretPathsIn(str(input.file_path));
    m.outbound = `${str(input.file_path)} ${str(input.caption)}`;
    return m;
  }
  if (name === "message_contact" || name === "ask_contact" || name === "create_chat") {
    const recipients = [
      str(input.phone_number),
      str(input.group_chat_id),
      str(input.handle),
      ...strs(input.handles),
    ].filter(Boolean);
    const text =
      `${str(input.message)} ${str(input.text)} ${str(input.additional_context)} ${str(input.question)}`.trim();
    const m = empty(`${name} to ${recipients.length} ${clip(text, 90)}`);
    m.message = { text, recipients, outsideChat: recipients.some((r) => !inChat(r)) };
    m.secretPaths = secretPathsIn(strs(input.media_paths).join(" "));
    m.outbound = `${text} ${strs(input.media_paths).join(" ")}`;
    return m;
  }
  if (name === "shelve" || name === "publish_mirror_asset" || name === "mount_page") {
    const m = empty(
      `${name} ${clip(str(input.file_path) || str(input.path) || str(input.title), 120)}`,
    );
    m.door = { kind: "publish", detail: name };
    m.secretPaths = secretPathsIn(`${str(input.file_path)} ${str(input.path)}`);
    m.outbound = `${str(input.file_path)} ${str(input.path)}`;
    return m;
  }
  if (name === "set_refresh_script" || name === "create_trigger" || name === "set_trigger") {
    // A script the harness will run on a timer: read like any other the turn writes.
    const script = `${str(input.script)} ${str(input.command)} ${str(input.check)}`;
    const m = empty(`${name} ${clip(str(input.name) || script, 100)}`);
    m.hosts = hostsIn(script, true);
    m.outbound = script;
    return m;
  }
  if (MESSAGE_READS.has(`${HARNESS}${name}`)) {
    const m = empty(`${name} ${clip(str(input.query) || str(input.msg_guid), 100)}`);
    m.readsMessages = true;
    return m;
  }
  if (WEB_READS.has(`${HARNESS}${name}`)) return meaningOf(`${HARNESS}${name}`, input, context);
  const m = empty(`${name} ${clip(JSON.stringify(input), 100)}`);
  m.outbound = Object.values(input)
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return m;
}
