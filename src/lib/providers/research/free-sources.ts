/**
 * Free, key-less outside sources (all public APIs meant for this use):
 *  - the company's job board via the official public posting APIs of Greenhouse, Lever and Ashby,
 *  - news articles via the GDELT DOC API,
 *  - Hacker News stories via the Algolia HN Search API.
 * Job boards return the postings themselves (real titles and descriptions). News and HN only return URLs;
 * the research loop fetches each article with the robots.txt-aware crawler and quotes it verbatim.
 */
import { getConfig } from "@/lib/config";
import { safeFetch } from "@/lib/security/ssrf";
import type { FetchedPage } from "./types";

type Fetch = (url: string) => Promise<{ status: number; body: string }>;

const defaultFetch: Fetch = async (url) => {
  const cfg = getConfig().research;
  const r = await safeFetch(url, { timeoutMs: 12_000, maxRedirects: 2, maxBytes: 2_000_000, userAgent: cfg.userAgent, accept: "application/json" });
  return { status: r.status, body: r.body };
};

const parse = <T,>(body: string): T | null => {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
};
const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const plain = (html: string | undefined) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const NEWSWORTHY = /\b(funding|raises?|raised|series [a-c]|seed round|launch(es|ed)?|soc ?2|iso ?27001|compliance|acquires?|acquired|investors?|backed)\b/i;
/** The company name as a whole word ("Plane" must not match "planes"). */
const nameRe = (name: string) => new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");

interface Board {
  provider: string;
  url: string;
  jobs: { title: string; location: string; text: string }[];
}

/** Try the company's job board on Greenhouse, Lever and Ashby (slug = domain root / company name). */
export async function findJobBoard(name: string | null, domain: string, linkedFromSite: string[] = [], fetchImpl: Fetch = defaultFetch): Promise<FetchedPage | null> {
  const root = domain.split(".")[0].toLowerCase();
  // Slugs the company's own site links to are trusted; guessed slugs must name the company's domain in a posting
  // (a guess like "plane" could otherwise belong to a different company).
  const linked = linkedFromSite
    .map((l) => {
      try {
        return new URL(l).pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
      } catch {
        return "";
      }
    })
    .filter((s) => /^[a-z0-9-]{2,}$/.test(s));
  const guessed = [root, (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")].filter((s) => s.length >= 3);
  const slugs = [...new Set([...linked, ...guessed])];
  const mentions = (slug: string, t: string) => linked.includes(slug) || t.toLowerCase().includes(domain.toLowerCase());

  for (const slug of slugs) {
    const attempts: (() => Promise<Board | null>)[] = [
      async () => {
        const r = await fetchImpl(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
        const j = r.status === 200 ? parse<{ jobs?: { title: string; location?: { name?: string }; content?: string }[] }>(r.body) : null;
        return j?.jobs?.length ? { provider: "Greenhouse", url: `https://job-boards.greenhouse.io/${slug}`, jobs: j.jobs.map((x) => ({ title: x.title, location: x.location?.name ?? "", text: plain(unescapeHtml(x.content ?? "")) })) } : null;
      },
      async () => {
        const r = await fetchImpl(`https://api.lever.co/v0/postings/${slug}?mode=json`);
        const j = r.status === 200 ? parse<{ text: string; categories?: { location?: string }; descriptionPlain?: string }[]>(r.body) : null;
        return Array.isArray(j) && j.length ? { provider: "Lever", url: `https://jobs.lever.co/${slug}`, jobs: j.map((x) => ({ title: x.text, location: x.categories?.location ?? "", text: x.descriptionPlain ?? "" })) } : null;
      },
      async () => {
        const r = await fetchImpl(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
        const j = r.status === 200 ? parse<{ jobs?: { title: string; location?: string; descriptionPlain?: string }[] }>(r.body) : null;
        return j?.jobs?.length ? { provider: "Ashby", url: `https://jobs.ashbyhq.com/${slug}`, jobs: j.jobs.map((x) => ({ title: x.title, location: x.location ?? "", text: x.descriptionPlain ?? "" })) } : null;
      },
    ];
    for (const attempt of attempts) {
      const board = await attempt().catch(() => null);
      // The slug must really be this company's board: some posting text has to name it.
      if (!board || !mentions(slug, board.jobs.map((j) => j.text).join(" "))) continue;
      const company = name ?? root;
      const lines = board.jobs.slice(0, 40).map((j) => `${j.title}${j.location ? ` — ${j.location}` : ""}.`);
      return {
        url: board.url,
        title: `${company} jobs (${board.provider})`,
        text: `${company} is hiring: ${board.jobs.length} open roles listed on its ${board.provider} job board.\n${lines.join("\n")}`,
        publishedAt: null,
        retrievedAt: new Date().toISOString(),
        sourceType: "search_result",
      };
    }
  }
  return null;
}

/** News article URLs about the company from GDELT (free, no key). */
let lastGdelt = 0;
export async function newsUrls(name: string, fetchImpl: Fetch = defaultFetch): Promise<{ url: string; title: string }[]> {
  // GDELT asks for at most one request every 5 seconds.
  const wait = lastGdelt + 5_500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGdelt = Date.now();
  const q = encodeURIComponent(`"${name}" (funding OR raises OR raised OR investors OR compliance)`);
  const r = await fetchImpl(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=15&format=json&sort=datedesc`).catch(() => null);
  const j = r?.status === 200 ? parse<{ articles?: { url: string; title: string }[] }>(r.body) : null;
  // Titles rarely name small companies; the caller keeps an article only if its fetched text does.
  return (j?.articles ?? []).slice(0, 4).map((a) => ({ url: a.url, title: a.title }));
}

/** Hacker News stories (launches, funding announcements) that link to an outside article. */
export async function hackerNewsUrls(name: string, domain: string, fetchImpl: Fetch = defaultFetch): Promise<{ url: string; title: string }[]> {
  const r = await fetchImpl(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(name)}&tags=story&hitsPerPage=20`).catch(() => null);
  const j = r?.status === 200 ? parse<{ hits?: { url?: string | null; title?: string }[] }>(r.body) : null;
  return (j?.hits ?? [])
    .filter((h) => h.url && nameRe(name).test(h.title ?? "") && NEWSWORTHY.test(h.title ?? ""))
    .filter((h) => !new URL(h.url!).hostname.endsWith(domain))
    .map((h) => ({ url: h.url!, title: h.title ?? "" }));
}

/** Public YC company directory (yc-oss JSON mirror of ycombinator.com/companies), cached for a day. */
export const YC_ALL_URL = "https://yc-oss.github.io/api/companies/all.json";
interface YcEntry {
  name: string;
  slug?: string;
  website?: string | null;
  one_liner?: string | null;
  batch?: string | null;
  status?: string | null;
  team_size?: number | null;
  stage?: string | null;
  isHiring?: boolean | null;
  url?: string | null;
}
let ycCache: { at: number; list: YcEntry[] } | null = null;
export function resetYcCache() {
  ycCache = null;
}

/**
 * The company's YC directory listing, as an outside source: YC invests in every company it lists, so a
 * listing is public evidence of venture backing. Matched on the website's domain only (never the name).
 */
export async function ycDirectoryPage(domain: string, fetchImpl: Fetch = (url) => defaultFetchLarge(url)): Promise<FetchedPage | null> {
  if (!ycCache || Date.now() - ycCache.at > 24 * 3_600_000) {
    const r = await fetchImpl(YC_ALL_URL);
    const list = r.status === 200 ? parse<YcEntry[]>(r.body) : null;
    if (!Array.isArray(list)) return null;
    ycCache = { at: Date.now(), list };
  }
  const host = (w: string | null | undefined) => {
    try {
      return new URL(w ?? "").hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const c = ycCache.list.find((x) => host(x.website) === domain.toLowerCase());
  if (!c || !c.batch) return null;
  const facts = [
    `${c.name} is backed by Y Combinator (batch: ${c.batch}).`,
    c.one_liner ? `${c.name}: ${c.one_liner}.` : "",
    c.status ? `Status: ${c.status}.` : "",
    c.team_size ? `Team size: ${c.team_size}.` : "",
    c.isHiring ? `${c.name} is currently hiring.` : "",
  ].filter(Boolean);
  return {
    url: c.url ?? `https://www.ycombinator.com/companies/${c.slug ?? ""}`,
    title: `${c.name} — Y Combinator company directory`,
    text: facts.join("\n"),
    publishedAt: null,
    retrievedAt: new Date().toISOString(),
    sourceType: "search_result",
  };
}

const defaultFetchLarge: Fetch = async (url) => {
  const cfg = getConfig().research;
  const r = await safeFetch(url, { timeoutMs: 45_000, maxRedirects: 2, maxBytes: 30_000_000, userAgent: cfg.userAgent, accept: "application/json" });
  return { status: r.status, body: r.body };
};
