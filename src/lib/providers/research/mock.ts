/** MockResearchProvider — serves the fictional `.example` fixture sites. Never touches the network. */
import { MOCK_SITES } from "@/lib/providers/mockFixtures";
import { scoreUrl, type CandidateUrl } from "./prioritize";
import type { CrawlLog, CrawlSession, FetchedPage, ResearchProvider } from "./types";

export class MockResearchProvider implements ResearchProvider {
  readonly name = "mock-research";
  readonly dataSource = "mock" as const;
  startSession(domain: string): CrawlSession {
    return new MockCrawlSession(domain);
  }
}

class MockCrawlSession implements CrawlSession {
  readonly dataSource = "mock" as const;
  private visited = new Set<string>();
  constructor(readonly domain: string) {}

  private site() {
    return MOCK_SITES[this.domain];
  }

  private page(path: string, p: { title: string; text: string; publishedAt?: string }): FetchedPage {
    return {
      url: `https://${this.domain}${path}`,
      title: p.title,
      text: p.text,
      publishedAt: p.publishedAt ?? null,
      retrievedAt: new Date().toISOString(),
      sourceType: "website",
    };
  }

  pagesFetched() {
    return this.visited.size;
  }

  async initialCrawl(maxPages: number) {
    const site = this.site();
    if (!site) {
      return {
        pages: [],
        log: [{ url: `https://${this.domain}/`, outcome: "error" as const, detail: "No mock fixture exists for this domain" }],
        reachable: false,
      };
    }
    const pages: FetchedPage[] = [];
    const log: CrawlLog[] = [];
    for (const [path, p] of Object.entries(site.linked).slice(0, maxPages)) {
      this.visited.add(path);
      pages.push(this.page(path, p));
      log.push({ url: `https://${this.domain}${path}`, outcome: "fetched", detail: "MOCK fixture" });
    }
    return { pages, log, reachable: true };
  }

  async fetchUrls(urls: string[], maxPages: number) {
    const site = this.site();
    const pages: FetchedPage[] = [];
    const log: CrawlLog[] = [];
    for (const raw of urls) {
      if (pages.length >= maxPages) break;
      let path: string;
      try {
        const u = new URL(raw, `https://${this.domain}`);
        if (u.hostname !== this.domain) {
          log.push({ url: raw, outcome: "off_site" });
          continue;
        }
        path = u.pathname.replace(/\/$/, "") || "/";
      } catch {
        log.push({ url: raw, outcome: "error", detail: "invalid URL" });
        continue;
      }
      if (this.visited.has(path)) continue;
      this.visited.add(path);
      const p = site?.deep[path] ?? site?.linked[path];
      if (!p) {
        log.push({ url: raw, outcome: "error", detail: "HTTP 404 (mock)" });
        continue;
      }
      pages.push(this.page(path, p));
      log.push({ url: raw, outcome: "fetched", detail: "MOCK fixture" });
    }
    return { pages, log };
  }

  unvisitedCandidates(limit: number): CandidateUrl[] {
    const site = this.site();
    if (!site) return [];
    // deep pages are "discoverable" (as if linked from the footer) but not fetched in round 0
    return [...Object.keys(site.linked), ...Object.keys(site.deep)]
      .filter((p) => !this.visited.has(p))
      .map((p) => scoreUrl(`https://${this.domain}${p}`, this.domain))
      .filter((c): c is CandidateUrl => c !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
