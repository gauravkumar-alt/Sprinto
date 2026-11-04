/**
 * WebsiteResearchProvider: a bounded, polite crawler for a company's public site.
 * Discovery via homepage links, robots.txt sitemaps and /sitemap.xml; pages are
 * prioritised by deterministic URL scoring; robots.txt and crawl-delay are honoured.
 */
import { getConfig } from "@/lib/config";
import { safeFetch } from "@/lib/security/ssrf";
import { KeyedRateLimiter, errorMessage, sha256 } from "@/lib/util";
import { renderWithBrowser } from "./browser";
import { extractHtml, parseSitemap } from "./html";
import { COMMON_PATHS, TRUST_SUBDOMAINS, type CandidateUrl, sameSite, scoreUrl } from "./prioritize";
import { ALLOW_ALL, parseRobots, type RobotsRules } from "./robots";
import type { CrawlLog, CrawlSession, FetchedPage, ResearchProvider } from "./types";

const hostLimiter = new KeyedRateLimiter(600);

export class WebsiteResearchProvider implements ResearchProvider {
  readonly name = "website-crawler";
  readonly dataSource = "real" as const;
  startSession(domain: string): CrawlSession {
    return new WebsiteCrawlSession(domain);
  }
}

class WebsiteCrawlSession implements CrawlSession {
  readonly dataSource = "real" as const;
  private cfg = getConfig().research;
  /** robots.txt rules per origin (apex, www, trust./security. subdomains each have their own). */
  private robotsByOrigin = new Map<string, RobotsRules>();
  private origin = "";
  private visited = new Set<string>();
  private hashes = new Set<string>();
  private candidates = new Map<string, CandidateUrl>();
  private fetchedCount = 0;

  constructor(readonly domain: string) {}

  pagesFetched() {
    return this.fetchedCount;
  }

  private fetchOpts(accept?: string) {
    return {
      timeoutMs: this.cfg.pageTimeoutMs,
      maxRedirects: this.cfg.maxRedirects,
      maxBytes: this.cfg.maxBytesPerPage,
      userAgent: this.cfg.userAgent,
      accept,
      allowUrl: (u: URL) => sameSite(u, this.domain), // the crawler never leaves the company's domain, even mid-redirect
    };
  }

  private async robotsFor(origin: string): Promise<RobotsRules> {
    const cached = this.robotsByOrigin.get(origin);
    if (cached) return cached;
    let rules = ALLOW_ALL;
    try {
      const r = await safeFetch(`${origin}/robots.txt`, this.fetchOpts("text/plain"));
      if (r.status === 200 && !/html/i.test(r.contentType)) rules = parseRobots(r.body, this.cfg.userAgent);
    } catch {
      /* unreachable or no robots.txt → default allow (standard crawler behaviour) */
    }
    this.robotsByOrigin.set(origin, rules);
    return rules;
  }

  private async politeWait(host: string, robots: RobotsRules) {
    const delay = Math.max(this.cfg.perHostDelayMs, robots.crawlDelayMs ?? 0);
    await hostLimiter.wait(host, delay);
  }

  private addCandidates(urls: string[]) {
    for (const raw of urls) {
      const c = scoreUrl(raw, this.domain);
      if (!c || this.visited.has(c.url)) continue;
      const prev = this.candidates.get(c.url);
      if (!prev || prev.score < c.score) this.candidates.set(c.url, c);
    }
  }

  unvisitedCandidates(limit: number): CandidateUrl[] {
    return [...this.candidates.values()]
      .filter((c) => !this.visited.has(c.url))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async initialCrawl(maxPages: number) {
    const log: CrawlLog[] = [];
    const pages: FetchedPage[] = [];

    // 1. homepage (https first, then http). robots.txt is read before the page itself.
    let home: FetchedPage | null = null;
    let reachable = false;
    for (const base of [`https://${this.domain}/`, `https://www.${this.domain}/`, `http://${this.domain}/`]) {
      const r = await this.fetchPage(base, log);
      if (log.some((l) => l.url === base && l.outcome === "skipped_robots")) {
        reachable = true;
        break;
      }
      if (r) {
        home = r.page;
        this.origin = new URL(r.finalUrl).origin;
        this.addCandidates(r.links);
        break;
      }
    }
    if (!home) return { pages, log, reachable };
    reachable = true;
    pages.push(home);

    // 2. sitemap discovery (bounded)
    const robots = await this.robotsFor(this.origin);
    const sitemapUrls = [...new Set([...robots.sitemaps, `${this.origin}/sitemap.xml`])].slice(0, 2);
    for (const sm of sitemapUrls) {
      try {
        if (!sameSite(new URL(sm), this.domain)) continue;
        const r = await safeFetch(sm, this.fetchOpts("application/xml,text/xml"));
        if (r.status !== 200) continue;
        const parsed = parseSitemap(r.body);
        this.addCandidates(parsed.urls.slice(0, 1000));
        const children = parsed.sitemaps.filter((s) => {
          try {
            return sameSite(new URL(s), this.domain);
          } catch {
            return false;
          }
        });
        for (const child of children.filter((s) => /page|main|company|en/i.test(s) || children.length <= 3).slice(0, 2)) {
          try {
            const rc = await safeFetch(child, this.fetchOpts("application/xml,text/xml"));
            if (rc.status === 200) this.addCandidates(parseSitemap(rc.body).urls.slice(0, 1000));
          } catch {
            /* ignore child sitemap errors */
          }
        }
      } catch {
        /* sitemap is optional */
      }
    }

    // 3. common paths and trust-centre subdomains as low-confidence candidates if not discovered
    const guesses = [...COMMON_PATHS.map((p) => this.origin + p), ...TRUST_SUBDOMAINS.map((s) => `https://${s}.${this.domain}/`)].filter(
      (u) => !this.candidates.has(u),
    );
    this.addCandidates(guesses);
    for (const u of guesses) {
      const c = this.candidates.get(u);
      if (c && c.tag !== "other") c.score -= 25; // undiscovered guesses rank below pages the site actually links to
    }

    // 4. best pages, one per tag first for breadth
    const ranked = this.unvisitedCandidates(40);
    const chosen: string[] = [];
    const tagsTaken = new Set<string>();
    for (const c of ranked) {
      if (tagsTaken.has(c.tag) || chosen.length >= maxPages - 1) continue;
      chosen.push(c.url);
      tagsTaken.add(c.tag);
    }
    // The rest in score order; fetchUrls stops after maxPages - 1 successes, so failed guesses don't use up the budget.
    for (const c of ranked) if (!chosen.includes(c.url)) chosen.push(c.url);

    const more = await this.fetchUrls(chosen, maxPages - 1);
    return { pages: [...pages, ...more.pages], log: [...log, ...more.log], reachable };
  }

  async fetchUrls(urls: string[], maxPages: number) {
    const log: CrawlLog[] = [];
    const pages: FetchedPage[] = [];
    let attempts = 0;
    for (const raw of urls) {
      if (pages.length >= maxPages || this.fetchedCount >= 1 + this.cfg.maxAdditionalPages || attempts >= maxPages * 2) break;
      attempts++;
      let u: URL;
      try {
        u = new URL(raw, this.origin || `https://${this.domain}`);
      } catch {
        log.push({ url: raw, outcome: "error", detail: "invalid URL" });
        continue;
      }
      if (!sameSite(u, this.domain)) {
        log.push({ url: raw, outcome: "off_site", detail: "not on the company's domain" });
        continue;
      }
      const r = await this.fetchPage(u.toString(), log);
      if (r) {
        pages.push(r.page);
        this.addCandidates(r.links);
      }
    }
    return { pages, log };
  }

  private async fetchPage(url: string, log: CrawlLog[]): Promise<{ page: FetchedPage; links: string[]; finalUrl: string } | null> {
    const key = url.replace(/\/$/, "") + "/";
    if (this.visited.has(url) || this.visited.has(key)) return null;
    this.visited.add(url);
    const u = new URL(url);
    const robots = await this.robotsFor(u.origin);
    if (!robots.allowed(u.pathname)) {
      log.push({ url, outcome: "skipped_robots" });
      return null;
    }
    await this.politeWait(u.hostname, robots);
    try {
      const r = await safeFetch(url, this.fetchOpts());
      if (!sameSite(new URL(r.finalUrl), this.domain)) {
        log.push({ url, outcome: "off_site", detail: `redirected to ${r.finalUrl}` });
        return null;
      }
      this.visited.add(r.finalUrl);
      const finalUrl = new URL(r.finalUrl);
      if (finalUrl.origin !== u.origin && !(await this.robotsFor(finalUrl.origin)).allowed(finalUrl.pathname)) {
        log.push({ url, outcome: "skipped_robots", detail: `redirect target ${r.finalUrl} is disallowed by robots.txt` });
        return null;
      }
      if (r.status >= 400) {
        log.push({ url, outcome: "error", detail: `HTTP ${r.status}` });
        return null;
      }
      if (!/html|text\/plain/i.test(r.contentType)) {
        log.push({ url, outcome: "not_html", detail: r.contentType });
        return null;
      }
      let ex = extractHtml(r.body, r.finalUrl, this.cfg.maxCharsPerPage);
      let rendered = false;
      // JavaScript-rendered page: plain HTML has too little visible text → render it in a headless browser.
      if (!ex.loginWall && ex.visibleChars < 400 && this.cfg.browserFallback) {
        const page = await renderWithBrowser(r.finalUrl, this.domain, { timeoutMs: this.cfg.pageTimeoutMs * 2, userAgent: this.cfg.userAgent });
        if (page) {
          const ex2 = extractHtml(page.html, page.finalUrl, this.cfg.maxCharsPerPage);
          if (ex2.visibleChars > ex.visibleChars) {
            ex = ex2;
            rendered = true;
          }
        }
      }
      if (ex.loginWall) {
        log.push({ url, outcome: "login_wall", detail: "login-protected content is not accessed" });
        return null;
      }
      if (ex.text.length < 80) {
        log.push({ url, outcome: "empty", detail: "little readable text (JS-rendered page?)" });
        return null;
      }
      const hash = sha256(ex.text);
      if (this.hashes.has(hash)) {
        log.push({ url, outcome: "duplicate" });
        return null;
      }
      this.hashes.add(hash);
      this.fetchedCount++;
      log.push({ url: r.finalUrl, outcome: "fetched", detail: rendered ? "rendered with headless browser" : undefined });
      return {
        page: {
          url: r.finalUrl,
          title: ex.title,
          text: ex.text,
          visibleChars: ex.visibleChars,
          publishedAt: ex.publishedAt,
          retrievedAt: new Date().toISOString(),
          sourceType: "website",
        },
        links: ex.links,
        finalUrl: r.finalUrl,
      };
    } catch (err) {
      log.push({ url, outcome: "error", detail: errorMessage(err) });
      return null;
    }
  }
}
