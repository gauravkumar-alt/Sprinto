/**
 * Hunter.io Domain Search adapter (GET /v2/domain-search).
 * - Maps only fields Hunter actually returns; missing values stay null.
 * - Results are cached per domain so re-runs do not spend searches.
 * - Monthly request counter is enforced locally (HUNTER_MONTHLY_LIMIT; the case
 *   cites 25/month on the free tier — your plan may differ).
 */
import { getConfig } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import { cleanField } from "@/lib/security/injection";
import type { ContactCandidate } from "@/lib/schemas";
import { KeyedRateLimiter, TransientError, monthKey, withRetry } from "@/lib/util";
import { ContactProviderError, type ContactProvider, type ContactSearchResult } from "./types";

interface HunterEmail {
  value?: string | null;
  type?: "personal" | "generic" | null;
  confidence?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null;
  department?: string | null;
  verification?: { date?: string | null; status?: string | null } | null;
  sources?: { uri?: string; extracted_on?: string | null }[] | null;
}
interface HunterResponse {
  data?: { domain?: string; organization?: string | null; emails?: HunterEmail[] };
  errors?: { id?: string; code?: number; details?: string }[];
}

const limiter = new KeyedRateLimiter(1100);

export function mapHunterEmail(e: HunterEmail): ContactCandidate {
  // Provider data is untrusted: one-line, markup-free, bounded fields before it reaches any prompt.
  const first = cleanField(e.first_name, 60) || null;
  const last = cleanField(e.last_name, 60) || null;
  return {
    name: first || last ? [first, last].filter(Boolean).join(" ") : null,
    firstName: first,
    lastName: last,
    title: cleanField(e.position, 120) || null,
    department: cleanField(e.department, 60) || null,
    seniority: cleanField(e.seniority, 40) || null,
    email: e.value?.trim().toLowerCase() || null,
    emailType: e.type ?? null,
    verificationStatus: e.verification?.status ?? null,
    providerConfidence: typeof e.confidence === "number" ? e.confidence : null,
    sources: (e.sources ?? []).filter((s) => s.uri).slice(0, 3).map((s) => ({ uri: s.uri!, extractedOn: s.extracted_on ?? null })),
    provider: "hunter",
    dataSource: "real",
  };
}

export function hunterUsageThisMonth(): number {
  const row = getDb().prepare("SELECT requests FROM api_usage WHERE provider='hunter' AND period=?").get(monthKey()) as
    | { requests: number }
    | undefined;
  return row?.requests ?? 0;
}

function recordUsage(failed: boolean) {
  getDb()
    .prepare(
      `INSERT INTO api_usage (provider, period, requests, failures) VALUES ('hunter', ?, 1, ?)
       ON CONFLICT(provider, period) DO UPDATE SET requests = requests + 1, failures = failures + excluded.failures`,
    )
    .run(monthKey(), failed ? 1 : 0);
}

export class HunterContactProvider implements ContactProvider {
  readonly name = "hunter";
  readonly dataSource = "real" as const;
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  async domainSearch(domain: string): Promise<ContactSearchResult> {
    const cfg = getConfig().hunter;
    const db = getDb();
    const cached = db.prepare("SELECT response_json, fetched_at FROM contact_search_cache WHERE domain=? AND provider='hunter'").get(domain) as
      | { response_json: string; fetched_at: string }
      | undefined;
    if (cached && Date.now() - Date.parse(cached.fetched_at) < cfg.cacheDays * 86_400_000) {
      const json = JSON.parse(cached.response_json) as HunterResponse;
      return { candidates: (json.data?.emails ?? []).map(mapHunterEmail), fromCache: true, organization: json.data?.organization ?? null, requestCounted: false };
    }

    if (hunterUsageThisMonth() >= cfg.monthlyLimit) {
      throw new ContactProviderError(
        `Hunter monthly limit reached (${cfg.monthlyLimit} searches). Add the contact manually or raise HUNTER_MONTHLY_LIMIT if your plan allows.`,
        "quota",
      );
    }

    const url = new URL("https://api.hunter.io/v2/domain-search");
    url.searchParams.set("domain", domain);
    url.searchParams.set("limit", String(cfg.resultLimit));
    url.searchParams.set("type", "personal");

    const json = await withRetry(async () => {
      await limiter.wait("hunter");
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { "X-API-KEY": this.apiKey }, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        throw new TransientError(`Hunter network error: ${(err as Error).message}`);
      }
      recordUsage(!res.ok);
      if (res.status === 401) throw new ContactProviderError("Hunter rejected the API key (401).", "auth");
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as HunterResponse;
        const err0 = body.errors?.[0];
        if (/usage/i.test(`${err0?.id ?? ""} ${err0?.details ?? ""}`))
          throw new ContactProviderError("Hunter account usage limit exceeded for this period.", "quota");
        throw new TransientError("Hunter rate limit (429)", 5_000);
      }
      if (res.status >= 500) throw new TransientError(`Hunter server error ${res.status}`);
      const body = (await res.json()) as HunterResponse;
      if (!res.ok) {
        throw new ContactProviderError(`Hunter error ${res.status}: ${body.errors?.[0]?.details ?? "unknown"}`, "bad_request");
      }
      return body;
    }, { retries: 2, baseMs: 2000 }).catch((err) => {
      if (err instanceof TransientError) throw new ContactProviderError(`Hunter unavailable: ${err.message}`, "unavailable");
      throw err;
    });

    db.prepare(
      `INSERT INTO contact_search_cache (domain, provider, response_json, fetched_at) VALUES (?, 'hunter', ?, ?)
       ON CONFLICT(domain) DO UPDATE SET response_json=excluded.response_json, fetched_at=excluded.fetched_at, provider='hunter'`,
    ).run(domain, JSON.stringify(json), nowIso());

    return { candidates: (json.data?.emails ?? []).map(mapHunterEmail), fromCache: false, organization: json.data?.organization ?? null, requestCounted: true };
  }
}
