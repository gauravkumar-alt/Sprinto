/**
 * Domain input validation. Accepts bare domains or URLs, normalises to a
 * registrable-looking hostname, and rejects anything that is not a public
 * domain name (IPs, localhost, single-label names, internal TLDs).
 */
export interface DomainParseResult {
  valid: { input: string; domain: string }[];
  invalid: { input: string; row?: number; reason: string }[];
  duplicates: string[];
}

const BLOCKED_TLDS = new Set(["local", "localhost", "internal", "intranet", "lan", "home", "corp", "test", "invalid", "onion"]);
/**
 * Shared suffixes where unrelated parties own the subdomains (a pragmatic subset of the Public Suffix List).
 * Entering one of these bare would make the crawler treat thousands of unrelated sites as "the company".
 */
const SHARED_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.in", "net.in", "org.in", "co.nz", "co.za", "co.jp",
  "com.br", "com.mx", "com.sg", "com.cn", "com.hk", "co.kr", "com.tr", "co.il",
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "workers.dev", "web.app",
  "firebaseapp.com", "azurewebsites.net", "cloudfront.net", "appspot.com", "blogspot.com", "wordpress.com",
  "notion.site", "webflow.io", "framer.website", "carrd.co", "wixsite.com", "squarespace.com", "myshopify.com",
  "substack.com", "medium.com", "onrender.com", "fly.dev", "railway.app",
]);

/** RFC 2606 reserved TLD used for clearly-labelled mock fixtures. */
export const MOCK_TLD = "example";

export function normalizeDomain(input: string): { domain?: string; error?: string } {
  let s = input.trim().toLowerCase();
  if (!s) return { error: "Empty value" };
  if (/\s/.test(s)) return { error: "Contains whitespace" };
  if (s.includes("@")) return { error: "Looks like an email address, expected a company domain" };
  if (!/^[a-z]+:\/\//.test(s)) s = "http://" + s;
  let host: string;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http(s) domains are supported" };
    if (u.username || u.password) return { error: "Credentials in URLs are not allowed" };
    host = u.hostname;
  } catch {
    return { error: "Not a valid domain or URL" };
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) {
    return { error: "IP addresses are not accepted; enter the company's domain" };
  }
  const labels = host.split(".");
  if (labels.length < 2) return { error: "Domain must include a TLD (e.g. acme.com)" };
  if (host.length > 253) return { error: "Domain too long" };
  for (const l of labels) {
    if (!/^[a-z0-9-]{1,63}$/.test(l) || l.startsWith("-") || l.endsWith("-")) {
      return { error: `Invalid label "${l}"` };
    }
  }
  const tld = labels[labels.length - 1];
  if (BLOCKED_TLDS.has(tld)) return { error: `".${tld}" is not a public domain` };
  if (SHARED_SUFFIXES.has(host)) return { error: `"${host}" is a shared suffix, not a company domain — enter the company's own domain` };
  if (!/^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(tld)) return { error: "Invalid top-level domain" };
  return { domain: host };
}

export const isMockDomain = (domain: string) => domain.endsWith("." + MOCK_TLD);

/** Parse free text (newline/comma separated) into validated, de-duplicated domains. */
export function parseDomainList(text: string): DomainParseResult {
  const items = text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return collect(items.map((input, i) => ({ input, row: i + 1 })));
}

const CSV_COLUMNS = ["domain", "website", "company_url", "url", "company_domain", "company website"];

/** Parse a CSV with a domain/website/company_url column (or a single unnamed column). */
export function parseDomainCsv(csv: string): DomainParseResult & { column?: string; error?: string } {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { valid: [], invalid: [], duplicates: [], error: "CSV is empty" };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let col = header.findIndex((h) => CSV_COLUMNS.includes(h));
  let start = 1;
  let column: string | undefined = header[col];
  if (col === -1) {
    if (header.length === 1 && !normalizeDomain(header[0]).error) {
      col = 0; // header-less single column of domains
      start = 0;
      column = undefined;
    } else {
      return {
        valid: [],
        invalid: [],
        duplicates: [],
        error: `No domain column found. Expected one of: ${CSV_COLUMNS.join(", ")}`,
      };
    }
  }
  const rows = lines.slice(start).map((line, i) => ({
    input: (splitCsvLine(line)[col] ?? "").trim(),
    row: i + start + 1,
  }));
  return { ...collect(rows), column };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function collect(rows: { input: string; row?: number }[]): DomainParseResult {
  const seen = new Set<string>();
  const res: DomainParseResult = { valid: [], invalid: [], duplicates: [] };
  for (const { input, row } of rows) {
    if (!input) {
      res.invalid.push({ input, row, reason: "Empty value" });
      continue;
    }
    const { domain, error } = normalizeDomain(input);
    if (!domain) {
      res.invalid.push({ input, row, reason: error! });
      continue;
    }
    if (seen.has(domain)) {
      res.duplicates.push(domain);
      continue;
    }
    seen.add(domain);
    res.valid.push({ input, domain });
  }
  return res;
}
