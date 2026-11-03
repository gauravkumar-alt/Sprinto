/**
 * Optional external search (Tavily adapter). When RESEARCH_PROVIDER/RESEARCH_API_KEY
 * are not configured the provider reports `available = false` and the research
 * loop never claims to have searched the web.
 */
import { getConfig } from "@/lib/config";
import { TransientError, withRetry } from "@/lib/util";
import type { SearchProvider, SearchResult } from "./types";

export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";
  constructor(private apiKey: string) {}
  get available() {
    return Boolean(this.apiKey);
  }
  async search(query: string): Promise<SearchResult[]> {
    return withRetry(async () => {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ query, max_results: 5, search_depth: "basic", topic: "general" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) throw new TransientError(`Tavily HTTP ${res.status}`);
      if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
      const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
      return (json.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({ title: r.title ?? "", url: r.url!, snippet: r.content ?? "", publishedAt: r.published_date ?? null }));
    }, { retries: 2 });
  }
}

export class NoSearchProvider implements SearchProvider {
  readonly name = "none";
  readonly available = false;
  async search(): Promise<SearchResult[]> {
    throw new Error("No external search provider is configured (set RESEARCH_PROVIDER=tavily and RESEARCH_API_KEY).");
  }
}

export function getSearchProvider(): SearchProvider {
  const { provider, apiKey } = getConfig().research;
  if (provider === "tavily" && apiKey) return new TavilySearchProvider(apiKey);
  return new NoSearchProvider();
}
