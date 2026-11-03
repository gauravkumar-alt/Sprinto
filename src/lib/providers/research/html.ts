/** Readable-text extraction and link discovery from HTML. */
import * as cheerio from "cheerio";

export interface ExtractedHtml {
  title: string;
  text: string;
  /** Length of the visible-text prefix of `text`; anything after it came from embedded page data. */
  visibleChars: number;
  publishedAt: string | null;
  links: string[];
  loginWall: boolean;
}

const STRIP = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "form", "button", "select",
  "nav", "footer", "header", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]",
  "[aria-hidden=true]", "[hidden]", ".cookie", ".cookies", "#cookie-banner", ".cookie-banner",
  "[class*=cookie-consent]", "[id*=cookie]", "[class*=newsletter]", "[class*=advert]", "[class*=popup]",
  "[class*=modal]",
];

export function extractHtml(html: string, baseUrl: string, maxChars: number): ExtractedHtml {
  const $ = cheerio.load(html);
  const title = ($("title").first().text() || $("meta[property='og:title']").attr("content") || "").trim();
  const metaDesc = ($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "").trim();
  const publishedAt =
    $("meta[property='article:published_time']").attr("content") ||
    $("meta[name='date']").attr("content") ||
    $("time[datetime]").first().attr("datetime") ||
    null;

  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const u = new URL(href, baseUrl);
      u.hash = "";
      links.add(u.toString());
    } catch {
      /* ignore malformed */
    }
  });

  // Collected before scripts are stripped: JS-rendered sites keep their copy in embedded data.
  const embedded = embeddedSentences($);

  const loginWall =
    $("input[type=password]").length > 0 && $("body").text().replace(/\s+/g, " ").length < 3000;

  $(STRIP.join(",")).remove();
  const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  // keep block structure so sentences don't run together
  root.find("p,li,h1,h2,h3,h4,h5,h6,div,section,br,tr,td,th,blockquote").each((_, el) => {
    $(el).append("\n");
  });
  const body = root
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1);
  // drop exact duplicate lines (repeated widgets, carousels)
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of body) {
    if (seen.has(l)) continue;
    seen.add(l);
    lines.push(l);
  }
  let text = (metaDesc ? metaDesc + "\n" : "") + lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const visibleChars = text.length;
  if (text.length < 1500 && embedded.length) {
    const have = new Set(lines);
    const extra = embedded.filter((s) => !have.has(s) && !text.includes(s));
    if (extra.length) text += "\n" + extra.join("\n");
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { title, text, visibleChars, publishedAt: publishedAt ?? null, links: [...links], loginWall };
}

/**
 * Natural-language sentences from inline JSON (JSON-LD, Next.js/React payloads).
 * Only prose-like strings are kept (≥ 6 words, mostly letters, no markup or code).
 */
export function embeddedSentences($: cheerio.CheerioAPI, maxChars = 8000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase();
    if (type && !/json|javascript|module/.test(type)) return;
    const src = $(el).html() ?? "";
    if (src.length < 40) return;
    for (const m of src.matchAll(/"((?:[^"\\]|\\.){40,800})"/g)) {
      let s: string;
      try {
        s = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        continue;
      }
      s = s.replace(/\s+/g, " ").trim();
      if (!isProse(s) || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      total += s.length;
      if (total > maxChars) return false;
    }
  });
  return out;
}

function isProse(s: string): boolean {
  if (s.split(" ").length < 6) return false;
  if (/[{}<>=;$\\|]|https?:\/\/|\b(function|var|const|return|null|undefined)\b|\.(js|css|png|svg)\b/.test(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  return letters / s.length > 0.7 && /[a-z]/.test(s);
}

export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  const sitemaps: string[] = [];
  $("sitemap > loc").each((_, el) => {
    sitemaps.push($(el).text().trim());
  });
  $("url > loc").each((_, el) => {
    urls.push($(el).text().trim());
  });
  return { urls, sitemaps };
}
