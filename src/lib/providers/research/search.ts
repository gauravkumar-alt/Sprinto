/**
 * Optional external search: Tavily, or Google Search through Gemini grounding (RESEARCH_PROVIDER=gemini,
 * reuses the Gemini LLM key). Gemini is only used to FIND source URLs — its own wording is never used as
 * evidence; the research loop fetches the real article and quotes it verbatim. When RESEARCH_PROVIDER/RESEARCH_API_KEY
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

interface GroundedResponse {
  candidates?: { groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[];
  error?: { message?: string };
}
const REDIRECT_HOST = "vertexaisearch.cloud.google.com";

export class GeminiSearchProvider implements SearchProvider {
  readonly name = "google (via Gemini grounding)";
  constructor(private apiKey: string, private model: string, private fetchImpl: typeof fetch = fetch) {}
  get available() {
    return Boolean(this.apiKey);
  }
  async search(query: string): Promise<SearchResult[]> {
    const json = await withRetry(async () => {
      const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Search the web and list news articles or press releases about: ${query}. Reply in one short paragraph.` }] }],
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 429 || res.status >= 500) throw new TransientError(`Gemini search HTTP ${res.status}`);
      const body = (await res.json()) as GroundedResponse;
      if (!res.ok) throw new Error(`Gemini search failed: HTTP ${res.status} ${body.error?.message?.slice(0, 160) ?? ""}`);
      return body;
    }, { retries: 1 });
    const chunks = json.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const out: SearchResult[] = [];
    for (const c of chunks.slice(0, 6)) {
      const url = c.web?.uri ? await this.resolve(c.web.uri) : null;
      if (url && !out.some((o) => o.url === url)) out.push({ title: c.web?.title ?? "", url, snippet: "", publishedAt: null });
    }
    return out;
  }
  /** Grounding links are Google redirects; read the target from the Location header without following it. */
  private async resolve(uri: string): Promise<string | null> {
    try {
      const u = new URL(uri);
      if (u.hostname !== REDIRECT_HOST) return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
      const res = await this.fetchImpl(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const loc = res.headers.get("location");
      const target = loc ? new URL(loc, u) : null;
      return target && (target.protocol === "https:" || target.protocol === "http:") ? target.toString() : null;
    } catch {
      return null;
    }
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
  if (provider === "gemini") {
    const llm = getConfig().llm;
    if (llm.provider === "gemini" && llm.apiKey) return new GeminiSearchProvider(llm.apiKey, llm.model);
  }
  return new NoSearchProvider();
}
