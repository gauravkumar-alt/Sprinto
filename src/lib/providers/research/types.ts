import type { DataSource } from "@/lib/schemas";
import type { CandidateUrl } from "./prioritize";

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  /** If set, only text[0, visibleChars) is visible on the page; the rest was recovered from embedded data. */
  visibleChars?: number;
  publishedAt: string | null;
  retrievedAt: string;
  sourceType: "website" | "search_result";
}

export interface CrawlLog {
  url: string;
  outcome: "fetched" | "skipped_robots" | "duplicate" | "error" | "login_wall" | "not_html" | "off_site" | "empty";
  detail?: string;
}

/** One research session per company. It is stateful across research-loop rounds so pages are never fetched twice. */
export interface CrawlSession {
  readonly domain: string;
  readonly dataSource: DataSource;
  /** Round 0: homepage + robots + sitemap discovery, then the best-scoring pages. */
  initialCrawl(maxPages: number): Promise<{ pages: FetchedPage[]; log: CrawlLog[]; reachable: boolean }>;
  /** Later rounds: fetch specific same-site URLs chosen by the research loop. */
  fetchUrls(urls: string[], maxPages: number): Promise<{ pages: FetchedPage[]; log: CrawlLog[] }>;
  /** Discovered but unvisited same-site URLs, best first. */
  unvisitedCandidates(limit: number): CandidateUrl[];
  pagesFetched(): number;
}

export interface ResearchProvider {
  readonly name: string;
  readonly dataSource: DataSource;
  startSession(domain: string): CrawlSession;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

export interface SearchProvider {
  readonly name: string;
  readonly available: boolean;
  search(query: string): Promise<SearchResult[]>;
}
