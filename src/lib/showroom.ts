/**
 * Showroom mode: a read-only copy of the results for hosts without the local database or keys
 * (e.g. Vercel). Enabled automatically for Vercel builds (SHOWROOM_BUILD is inlined at build time)
 * or with SHOWROOM=true.
 *
 * Data source: the latest snapshot published to Supabase by the Mac running the agent
 * (table public.showroom_snapshot, read with the public anon key — read-only by RLS).
 * Falls back to the bundled src/showroom/snapshot.json placeholder when Supabase isn't configured.
 * Every email address in a snapshot is already partly masked. No database, provider or secret is used here.
 */
import bundled from "@/showroom/snapshot.json";

export { isShowroom } from "./showroom-flag";

export type Snapshot = {
  generatedAt: string | null;
  status: Record<string, unknown> | null;
  companies: Record<string, Record<string, unknown>>;
  qualification: Record<string, Record<string, unknown>>;
};

const CACHE_MS = 30_000;
const g = globalThis as unknown as { __showroomCache?: { at: number; snap: Snapshot } };

export function supabaseReadConfig() {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY ?? "";
  return url && key ? { url, key } : null;
}

/** New-style keys (sb_publishable_…, sb_secret_…) go only in `apikey`; legacy JWT keys also as a Bearer token. */
export function supabaseHeaders(key: string): Record<string, string> {
  return key.startsWith("eyJ") ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

export async function getSnapshot(fetchImpl: typeof fetch = fetch): Promise<Snapshot> {
  const cfg = supabaseReadConfig();
  if (!cfg) return bundled as Snapshot;
  if (g.__showroomCache && Date.now() - g.__showroomCache.at < CACHE_MS) return g.__showroomCache.snap;
  try {
    const res = await fetchImpl(`${cfg.url}/rest/v1/showroom_snapshot?id=eq.1&select=payload`, {
      headers: supabaseHeaders(cfg.key),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    const rows = (await res.json()) as { payload: Snapshot }[];
    const snap = rows[0]?.payload ?? (bundled as Snapshot);
    g.__showroomCache = { at: Date.now(), snap };
    return snap;
  } catch {
    // Serve the last good copy if Supabase is briefly unreachable; otherwise the empty placeholder.
    return g.__showroomCache?.snap ?? (bundled as Snapshot);
  }
}

export function resetShowroomCache() {
  delete g.__showroomCache;
}
