/**
 * SSRF-safe HTTP fetching for the crawler.
 *
 *  - http/https only, default ports only, no credentials in URLs
 *  - every DNS answer is checked at *connect time* (custom undici lookup), so
 *    a hostname cannot resolve to a private address via DNS rebinding
 *  - redirects are followed manually and each hop is re-validated
 *  - bounded timeout and response size; only HTML/text content is read
 */
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
  }
  return true;
}

export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError(`Blocked scheme ${u.protocol}`);
  if (u.username || u.password) throw new BlockedUrlError("Credentials in URL are not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new BlockedUrlError(`Blocked non-standard port ${u.port}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError(`Blocked private address ${host}`);
  if (net.isIP(host)) throw new BlockedUrlError("Raw IP addresses are not crawled");
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)) throw new BlockedUrlError(`Blocked internal host ${host}`);
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      const e = new BlockedUrlError(`Blocked: ${hostname} resolves to a private/reserved address`) as unknown as NodeJS.ErrnoException;
      return cb(e, "", 4);
    }
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

let agent: Agent | undefined;
function getAgent() {
  agent ??= new Agent({ connect: { lookup: safeLookup as never }, connections: 8 });
  return agent;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  redirects: number;
}

export async function safeFetch(
  rawUrl: string,
  opts: { timeoutMs: number; maxRedirects: number; maxBytes: number; userAgent: string; accept?: string; allowUrl?: (u: URL) => boolean },
): Promise<SafeFetchResult> {
  let url = assertPublicHttpUrl(rawUrl);
  if (opts.allowUrl && !opts.allowUrl(url)) throw new BlockedUrlError(`Not on the allowed site: ${url.hostname}`);
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await undiciFetch(url.toString(), {
        dispatcher: getAgent(),
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": opts.userAgent,
          accept: opts.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.8,application/xml;q=0.7",
          "accept-language": "en",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new Error(`Redirect without location (${res.status})`);
        url = assertPublicHttpUrl(new URL(loc, url).toString());
        // Every hop of a redirect chain must stay on the allowed site (not just the final URL).
        if (opts.allowUrl && !opts.allowUrl(url)) throw new BlockedUrlError(`Redirect left the company's site: ${url.hostname}`);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const body = await readLimited(res.body as unknown as ReadableStream<Uint8Array> | null, opts.maxBytes);
      return { finalUrl: url.toString(), status: res.status, contentType, body, redirects: hop };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new Error(`Timed out after ${opts.timeoutMs}ms: ${url}`);
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof BlockedUrlError) throw cause;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BlockedUrlError(`Too many redirects (> ${opts.maxRedirects})`);
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
