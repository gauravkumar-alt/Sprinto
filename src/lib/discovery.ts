/**
 * "Find fit companies": a cheap screen that runs before the full agent so research time and AI quota
 * go to companies that can actually qualify.
 *
 * 1. Candidates come from the public YC company directory (yc-oss API, a JSON mirror of
 *    ycombinator.com/companies), filtered to active B2B/SaaS companies that are hiring and have
 *    15–300 people, which roughly matches Series A–C.
 * 2. Each candidate's own website (homepage plus its best security/trust page) is read with the same
 *    robots.txt-aware crawler the agent uses. No AI is used and nothing is sent anywhere.
 * 3. Companies that already show SOC 2 / ISO 27001 are set aside. The rest are suggested, with the
 *    reason, and only run through the agent when the user adds them.
 */
import { getConfig } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import { CERT_RE, PREP_RE, showsCertificationHeld } from "@/lib/pipeline/qualification";
import { scoreUrl } from "@/lib/providers/research/prioritize";
import type { FetchedPage, ResearchProvider } from "@/lib/providers/research/types";
import { WebsiteResearchProvider } from "@/lib/providers/research/website";
import { normalizeDomain } from "@/lib/security/domain";
import { safeFetch } from "@/lib/security/ssrf";
import { createLimiter, errorMessage } from "@/lib/util";

export const YC_HIRING_URL = "https://yc-oss.github.io/api/companies/hiring.json";

export interface YcCompany {
  name: string;
  website?: string | null;
  one_liner?: string | null;
  team_size?: number | null;
  industry?: string | null;
  subindustry?: string | null;
  tags?: string[] | null;
  status?: string | null;
  nonprofit?: boolean | null;
  batch?: string | null;
  all_locations?: string | null;
  launched_at?: number | null;
}

export interface Candidate {
  domain: string;
  name: string;
  source: string;
  details: { oneLiner: string; teamSize: number | null; batch: string; location: string; sector: string };
}

export type Verdict = "fit" | "preparing" | "certified" | "unreachable";

export interface ScreenResult {
  verdict: Verdict;
  reason: string;
  quote: string | null;
  quoteUrl: string | null;
}

/** Sectors where buyers most often ask vendors for SOC 2 (ranked first). */
const PRIORITY_SECTORS = /security|infrastructure|engineering|finance|accounting|human resources|recruiting|legal|analytics|productivity|operations|sales|marketing|data/i;

const COMPETITOR = /\b(managed )?compliance (automation|platform|software|services?|execution)\b|\bcompliance as a service\b|\bsoc ?2\b|\biso ?27001\b|\bgrc\b|\btrust (center|management)\b|\bsecurity questionnaires?\b/i;

/** Pick unscreened B2B/SaaS candidates from the YC directory, best first. */
export function pickCandidates(list: YcCompany[], exclude: Set<string>, limit: number): Candidate[] {
  const out: (Candidate & { rank: number; launched: number })[] = [];
  for (const c of list) {
    if (c.status !== "Active" || c.nonprofit || !c.website) continue;
    const tags = (c.tags ?? []).map((t) => t.toLowerCase());
    const saasish = tags.includes("saas") || tags.includes("b2b") || tags.includes("enterprise software");
    if (c.industry !== "B2B" && !((c.industry === "Fintech" || c.industry === "Healthcare") && saasish)) continue;
    // Compliance-automation vendors compete with Sprinto; they are never prospects.
    if (tags.includes("compliance") || COMPETITOR.test(`${c.one_liner ?? ""} ${tags.join(" ")}`)) continue;
    const team = c.team_size ?? 0;
    if (team < 15 || team > 300) continue;
    let host = "";
    try {
      host = new URL(c.website).hostname;
    } catch {
      continue;
    }
    const { domain } = normalizeDomain(host);
    if (!domain || exclude.has(domain)) continue;
    exclude.add(domain); // two directory entries can share a domain
    let rank = 0;
    if (PRIORITY_SECTORS.test(c.subindustry ?? "")) rank += 3;
    if (tags.includes("saas")) rank += 2;
    if (tags.includes("b2b")) rank += 1;
    if (team >= 30 && team <= 150) rank += 1;
    out.push({
      domain,
      name: c.name,
      source: "YC directory",
      details: {
        oneLiner: c.one_liner ?? "",
        teamSize: c.team_size ?? null,
        batch: c.batch ?? "",
        location: c.all_locations ?? "",
        sector: (c.subindustry ?? c.industry ?? "").replace(/^B2B -> /, ""),
      },
      rank,
      launched: c.launched_at ?? 0,
    });
  }
  return out
    .sort((a, b) => b.rank - a.rank || b.launched - a.launched)
    .slice(0, limit)
    .map((c) => ({ domain: c.domain, name: c.name, source: c.source, details: c.details }));
}

/** Sentences, also split where a site omits the space ("…certification?Not currently."). */
const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s*(?=[A-Z0-9“"])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && s.length < 400);
/** "SOC 2 Type II" as a badge or label, without a verb. */
const BADGE_RE = /\bsoc\s*-?\s*(2|ii|two)\s*(type\s*(ii|2|i|1)\b)/i;
const NEGATED = /\bnot (yet )?(soc|iso|certified|compliant)|\bno soc\b|\bisn'?t\b|\bnot currently\b/i;
/** About the company's hosting or vendors ("our cloud providers are SOC 2 certified"), not the company itself. */
const SOMEONE_ELSE = /\b(providers?|vendors?|sub-?processors?|data ?cent(er|re)s?|aws|amazon web services|google cloud|gcp|azure|stripe|partners?)\b/i;
/** Certified, in Spanish, Portuguese, German and French. */
const FOREIGN_HELD = /\b(certificad[oa]s?|zertifiziert|certifi[ée]e?s?)\b/i;
/** Announcing its own certification ("Alex achieves SOC 2 Type II"), the one kind of blog post that counts. */
const ANNOUNCED = /\b(achiev|receiv|complet|earn|obtain|pass)\w*\b/i;
const ARTICLE_PATH = /\/(blog|docs|articles?|resources\/blog|guides?|learn|glossary|posts?)(\/|$)/i;
const STATUS_LINE = /^(status|state)\s*:?\s*(compliant|certified|audited|attested|achieved|active)\b/i;
const TRUST_CENTER = /\btrust (center|centre|portal|hub)\b/i;

/** Decide from the fetched pages whether a company already shows SOC 2 / ISO 27001. */
export function judgePages(pages: FetchedPage[], domain: string): ScreenResult {
  if (!pages.length) return { verdict: "unreachable", reason: "Website couldn't be read (down, blocked by robots.txt, or JavaScript-only)", quote: null, quoteUrl: null };
  const nameRe = new RegExp(`\\b${domain.split(".")[0].replace(/[^a-z0-9]/gi, "")}\\b`, "i");
  let preparing: { s: string; url: string } | null = null;
  let trust: string | null = null;
  for (const p of pages) {
    const tag = scoreUrl(p.url, domain)?.tag ?? null;
    // Articles and docs often discuss certifications in general ("what is SOC 2"); there only the
    // company announcing its own certification counts.
    const article = tag === "blog" || tag === "docs" || ARTICLE_PATH.test(new URL(p.url).pathname);
    for (const s of [p.title, ...sentencesOf(p.text)]) {
      if (!s || !CERT_RE.test(s)) {
        if (!article && s && !trust && TRUST_CENTER.test(s)) trust = p.url;
        continue;
      }
      if (s.endsWith("?") || SOMEONE_ELSE.test(s)) continue; // a question, or about its hosting/vendors
      const planned = PREP_RE.test(s) || NEGATED.test(s);
      const held = article
        ? nameRe.test(s) && ANNOUNCED.test(s) && !planned
        : showsCertificationHeld(s, tag) || (!planned && (BADGE_RE.test(s) || FOREIGN_HELD.test(s)));
      if (held) return { verdict: "certified", reason: "Already shows a certification on its own site", quote: s, quoteUrl: p.url };
      if (!article && !preparing && PREP_RE.test(s) && !NEGATED.test(s)) preparing = { s, url: p.url };
    }
  }
  // A status table: a certification heading followed by its status a line or two below
  // ("SOC 2" / description / "Status: Compliant").
  for (const p of pages) {
    const lines = p.text.split("\n").map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 30 || !CERT_RE.test(lines[i])) continue;
      const status = lines.slice(i + 1, i + 3).find((l) => STATUS_LINE.test(l));
      if (status) return { verdict: "certified", reason: "Already shows a certification on its own site", quote: `${lines[i]} — ${status}`, quoteUrl: p.url };
    }
  }
  if (preparing) return { verdict: "preparing", reason: "Says it is working toward a certification — a strong buying signal", quote: preparing.s, quoteUrl: preparing.url };
  if (trust) return { verdict: "certified", reason: "Has a trust center (these usually publish a SOC 2 report)", quote: null, quoteUrl: trust };
  const names = pages.map((p) => scoreUrl(p.url, domain)?.tag ?? "page").map((t) => (t === "other" ? "homepage" : t));
  return { verdict: "fit", reason: `No SOC 2 / ISO 27001 found on ${pages.length} page${pages.length === 1 ? "" : "s"} read (${[...new Set(names)].join(", ")})`, quote: null, quoteUrl: null };
}

export async function screen(domain: string, research: ResearchProvider): Promise<ScreenResult> {
  const session = research.startSession(domain);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 60_000));
  try {
    const { pages } = await Promise.race([session.initialCrawl(5), timeout]);
    return judgePages(pages, domain);
  } catch (err) {
    return { verdict: "unreachable", reason: `Website couldn't be read (${errorMessage(err)})`, quote: null, quoteUrl: null };
  }
}

async function loadDirectory(): Promise<YcCompany[]> {
  const r = await safeFetch(YC_HIRING_URL, { timeoutMs: 30_000, maxRedirects: 2, maxBytes: 8_000_000, userAgent: getConfig().research.userAgent, accept: "application/json" });
  if (r.status !== 200) throw new Error(`Company directory returned HTTP ${r.status}`);
  const list = JSON.parse(r.body) as YcCompany[];
  if (!Array.isArray(list)) throw new Error("Company directory returned an unexpected format");
  return list;
}

interface DiscoveryState {
  running: boolean;
  screened: number;
  total: number;
  error: string | null;
  lastRunAt: string | null;
}
const g = globalThis as unknown as { __discovery?: DiscoveryState };
const state = (): DiscoveryState => (g.__discovery ??= { running: false, screened: 0, total: 0, error: null, lastRunAt: null });

/** Screen the next `limit` candidates. Returns false if a screen is already running. */
export function startDiscovery(
  limit = 12,
  deps: { directory?: () => Promise<YcCompany[]>; research?: ResearchProvider } = {},
): { started: boolean; done: Promise<void> } {
  const st = state();
  if (st.running) return { started: false, done: Promise.resolve() };
  Object.assign(st, { running: true, screened: 0, total: 0, error: null });
  const done = (async () => {
    try {
      const db = getDb();
      const known = new Set<string>([
        ...(db.prepare("SELECT domain FROM companies").all() as { domain: string }[]).map((r) => r.domain),
        ...(db.prepare("SELECT domain FROM discovered_companies").all() as { domain: string }[]).map((r) => r.domain),
      ]);
      const candidates = pickCandidates(await (deps.directory ?? loadDirectory)(), known, limit);
      st.total = candidates.length;
      const research = deps.research ?? new WebsiteResearchProvider();
      const limitRun = createLimiter(3);
      const insert = db.prepare(
        `INSERT OR REPLACE INTO discovered_companies (domain, name, source, verdict, reason, quote, quote_url, details, screened_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      await Promise.all(
        candidates.map((c) =>
          limitRun(async () => {
            const r = await screen(c.domain, research);
            insert.run(c.domain, c.name, c.source, r.verdict, r.reason, r.quote, r.quoteUrl, JSON.stringify(c.details), nowIso());
            st.screened++;
          }),
        ),
      );
    } catch (err) {
      st.error = errorMessage(err);
    } finally {
      st.running = false;
      st.lastRunAt = nowIso();
    }
  })();
  return { started: true, done };
}

export interface DiscoveredRow {
  domain: string;
  name: string;
  source: string;
  verdict: Verdict;
  reason: string;
  quote: string | null;
  quoteUrl: string | null;
  details: Candidate["details"];
  screenedAt: string;
  inAgent: boolean;
}

/** Suggestions (fit and preparing first) plus how many were set aside, and the screen's progress. */
export function discoveryStatus() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.*, EXISTS(SELECT 1 FROM companies c WHERE c.domain = d.domain) AS in_agent FROM discovered_companies d
       ORDER BY CASE d.verdict WHEN 'preparing' THEN 0 WHEN 'fit' THEN 1 WHEN 'certified' THEN 2 ELSE 3 END, d.screened_at DESC`,
    )
    .all() as { domain: string; name: string; source: string; verdict: Verdict; reason: string; quote: string | null; quote_url: string | null; details: string; screened_at: string; in_agent: number }[];
  const items: DiscoveredRow[] = rows.map((r) => ({
    domain: r.domain,
    name: r.name,
    source: r.source,
    verdict: r.verdict,
    reason: r.reason,
    quote: r.quote,
    quoteUrl: r.quote_url,
    details: JSON.parse(r.details),
    screenedAt: r.screened_at,
    inAgent: Boolean(r.in_agent),
  }));
  const counts = { fit: 0, preparing: 0, certified: 0, unreachable: 0 } as Record<Verdict, number>;
  for (const i of items) counts[i.verdict]++;
  return { ...state(), counts, items };
}
