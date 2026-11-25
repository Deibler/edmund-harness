/**
 * What a request says about who sent it, read from the request alone.
 *
 * Anything with a public address is found within hours by programs that ask
 * every address for the same few hundred things: a secrets file, an admin
 * page of software that is not installed, a router's setup form. They are not
 * visitors, and a log that cannot tell them from visitors answers neither
 * "who is using this" nor "is someone trying something".
 *
 * Two readings, both from what is already in hand when the request arrives:
 * what kind of client the user agent claims to be, and which known probes the
 * method and address match. The address is read whole, query included, and
 * only the names of what matched are kept: the access log never stores a
 * query string, and this does not change that.
 */

export type ClientKind = "browser" | "preview" | "crawler" | "tool" | "scanner" | "unknown";

const SCANNERS =
  /zgrab|masscan|nmap|nikto|sqlmap|nuclei|gobuster|dirbuster|feroxbuster|wpscan|acunetix|nessus|openvas|censys|shodan|expanse|l9explore|internet-measurement|netsystemsresearch|paloalto|cypex|odin|httpx|fuzz faster|ffuf|hydra|metasploit/i;
const PREVIEWS =
  /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|linkedinbot|whatsapp|telegrambot|discordbot|skypeuripreview|iframely|embedly|pinterest|redditbot|applebot.*preview|imessage|bitlybot|vkshare/i;
const CRAWLERS =
  /googlebot|google-inspectiontool|adsbot|bingbot|duckduckbot|yandex|baiduspider|sogou|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-web|anthropic-ai|ccbot|perplexitybot|bytespider|amazonbot|applebot|ia_archiver|archive\.org_bot|seznambot|dataforseo|blexbot|crawler|spider|\bbot\b/i;
const TOOLS =
  /^(curl|wget|httpie|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|okhttp|java|apache-httpclient|libwww-perl|node-fetch|axios|undici|got|ruby|php|postmanruntime|insomnia|bun|deno|node)\b/i;

/** The kind of client a user agent claims to be, and the name it gives. */
export function classifyClient(userAgent: string | null | undefined): {
  kind: ClientKind;
  name?: string;
} {
  const ua = (userAgent ?? "").trim();
  if (!ua) return { kind: "unknown" };
  const named = (re: RegExp) => re.exec(ua)?.[0]?.toLowerCase();
  const scanner = named(SCANNERS);
  if (scanner) return { kind: "scanner", name: scanner };
  const preview = named(PREVIEWS);
  if (preview) return { kind: "preview", name: preview };
  const crawler = named(CRAWLERS);
  if (crawler) return { kind: "crawler", name: crawler };
  const tool = named(TOOLS);
  if (tool) return { kind: "tool", name: tool };
  if (/mozilla\/\d/i.test(ua) && /(chrome|safari|firefox|edg|opr)\//i.test(ua)) {
    return { kind: "browser" };
  }
  return { kind: "unknown" };
}

const SIGNATURES: [name: string, pattern: RegExp][] = [
  // Files that hold credentials or the source tree.
  [
    "probe:secrets",
    /\/\.(env|git|svn|hg|aws|ssh|npmrc|docker|kube|htpasswd|htaccess|vscode|idea)(\b|\/|\.)|\/(id_rsa|id_ed25519|credentials|secrets?\.(json|ya?ml|txt)|wp-config|config\.(php|json|ya?ml|inc)|settings\.py|database\.ya?ml|dump\.sql|backup\.(zip|sql|tar|gz)|\.DS_Store)(\b|$)/i,
  ],
  // Admin pages of software that is not here.
  [
    "probe:cms",
    /\/(wp-login\.php|wp-admin|wp-content|wp-includes|xmlrpc\.php|wordpress|joomla|drupal|administrator\/|phpmyadmin|pma\/|adminer|typo3|magento|owa\/|ecp\/|autodiscover)/i,
  ],
  [
    "probe:admin",
    /\/(actuator|server-status|server-info|manager\/html|jenkins|hudson|solr\/|jolokia|console\/|_cat\/|_cluster\/|api\/v1\/(pods|namespaces|secrets)|v2\/_catalog|debug\/pprof|telescope|horizon|\.well-known\/.*\.php)/i,
  ],
  // Routers, cameras and modems.
  [
    "probe:device",
    /\/(boaform|HNAP1|cgi-bin\/|goform|setup\.cgi|GponForm|tmUnblock\.cgi|currentsetting\.htm|hudson|shell\?|luci\/|web_shell_cmd|onvif|SDK\/webLanguage|portal\/redlion|remote\/fgt_lang|dana-na|vpn\/index)/i,
  ],
  // Known remote-execution addresses, and any script of a kind this server never runs.
  [
    "probe:exploit",
    /(vendor\/phpunit|eval-stdin\.php|\/shell\.php|\/cmd\.php|\/c99\.php|ThinkPHP|invokefunction|\/struts|\.action\b|\/\.\.;\/|\$\{jndi:|\.(php\d?|asp|aspx|jsp|cgi)(\?|\/|$))/i,
  ],
  [
    "traversal",
    /(\.\.\/|\.\.\\|%2e%2e(%2f|\/)|\.\.%2f|%252e%252e|\/etc\/passwd|\/proc\/self|\/windows\/win\.ini)/i,
  ],
  [
    "injection",
    /(union[\s+%20]+(all[\s+%20]+)?select|select[\s+%20].+[\s+%20]from|sleep\(\d|benchmark\(|<script|%3cscript|javascript:|onerror=|;(cat|ls|id|wget|curl)[\s+%20]|\|\|?(cat|id|wget|curl)[\s+%20]|`(id|whoami)`|\$\((id|whoami)\))/i,
  ],
];

const ODD_METHODS = new Set(["CONNECT", "TRACE", "TRACK", "PROPFIND", "DEBUG", "SEARCH"]);

/**
 * The names of the known probes a request matches; empty for an ordinary one.
 * `address` is the path and query as they arrived.
 */
export function threatSignals(
  method: string,
  address: string,
  userAgent: string | null | undefined,
): string[] {
  const found: string[] = [];
  let decoded = address;
  try {
    decoded = decodeURIComponent(address);
  } catch {
    // Not valid percent-encoding: the patterns read it as it came.
  }
  const text = decoded === address ? address : `${address} ${decoded}`;
  for (const [name, pattern] of SIGNATURES) {
    if (pattern.test(text)) found.push(name);
  }
  if (ODD_METHODS.has(method.toUpperCase())) found.push("method");
  if (classifyClient(userAgent).kind === "scanner") found.push("scanner");
  return found;
}
