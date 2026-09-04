import { resolve4, resolve6 } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // RFC 2544 benchmark
  if (a === 240) return true; // reserved
  if (a === 255 && parts.every((p) => p === 255)) return true; // broadcast
  return false;
}

function isPrivateIp(ip: string): boolean {
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const parts = [
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4]),
    ];
    if (parts.some((p) => p > 255)) return false;
    return isPrivateIpv4(parts);
  }

  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1") return true;
  // IPv6 ULA (fc00::/7)
  if (/^f[cd]/i.test(lower)) return true;
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab]/i.test(lower)) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "metadata.google.internal"
  );
}

export async function assertPublicUrl(urlOrStr: URL | string): Promise<void> {
  const url = typeof urlOrStr === "string" ? new URL(urlOrStr) : urlOrStr;

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError("Only http and https URLs are allowed");
  }

  const { hostname } = url;

  if (isBlockedHostname(hostname)) {
    throw new SsrfBlockedError(`Blocked hostname: ${hostname}`);
  }

  if (isPrivateIp(hostname)) {
    throw new SsrfBlockedError(`Blocked private IP address: ${hostname}`);
  }

  // DNS phase: resolve and check all returned addresses
  const [v4result, v6result] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);

  const resolved: string[] = [];
  if (v4result.status === "fulfilled") resolved.push(...v4result.value);
  if (v6result.status === "fulfilled") resolved.push(...v6result.value);

  for (const addr of resolved) {
    if (isPrivateIp(addr)) {
      throw new SsrfBlockedError(`Blocked: ${hostname} resolves to private address ${addr}`);
    }
  }
}
