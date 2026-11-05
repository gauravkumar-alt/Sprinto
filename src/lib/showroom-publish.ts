/**
 * Publishes the current results to Supabase for the read-only public site (runs on the Mac only).
 * Writes with SUPABASE_SERVICE_ROLE_KEY, which must stay in .env.local and never reach the browser,
 * GitHub or Vercel. Every email address is partly masked; publishing is refused if one is not.
 */
import { providerStatus } from "./providers";
import { companyDetail, dashboardMetrics, listCompanies, recentBatches } from "./queries";
import { qualificationReport } from "./report";
import * as repo from "./repo";
import { supabaseHeaders, type Snapshot } from "./showroom";
import { hasFullEmail, maskPayload, publicCompanyDetail } from "./viewer";

export function buildSnapshot(): Snapshot {
  // Real research only: fictional .example demo companies stay on this computer.
  const companies = listCompanies().filter((c) => c.dataSource !== "mock");
  const details: Record<string, Record<string, unknown>> = {};
  const reports: Record<string, Record<string, unknown>> = {};
  for (const c of companies) {
    details[c.id] = { ...publicCompanyDetail(companyDetail(c.id)), readOnly: true };
    const q = repo.latestQualification(c.id);
    if (q?.categories) reports[c.id] = qualificationReport(q, c.domain, c.name);
  }
  const snap = maskPayload({
    generatedAt: new Date().toISOString(),
    status: {
      providers: providerStatus(),
      metrics: {
        ...dashboardMetrics(),
        totalCompanies: companies.length,
        qualified: companies.filter((c) => c.decision === "qualified").length,
        notQualified: companies.filter((c) => c.status === "not_qualified").length,
        needsReview: companies.filter((c) => ["needs_review", "contact_not_found", "email_needs_review"].includes(c.status)).length,
        emailsGenerated: companies.filter((c) => c.emailStatus).length,
        emailsSent: companies.filter((c) => c.emailStatus === "sent").length,
        emailsSimulated: 0,
        running: 0,
      },
      batches: recentBatches(),
      companies,
      readOnly: true,
    },
    companies: details,
    qualification: reports,
  }) as Snapshot;
  if (hasFullEmail(JSON.stringify(snap))) throw new Error("Snapshot still contains a full email address — not published.");
  return snap;
}

export function supabaseWriteConfig() {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return url && key ? { url, key } : null;
}

/** Upsert the single snapshot row. Returns a short status line; never throws for "not configured". */
export async function publishSnapshot(fetchImpl: typeof fetch = fetch): Promise<string> {
  const cfg = supabaseWriteConfig();
  if (!cfg) return "Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — skipped.";
  const snap = buildSnapshot();
  const res = await fetchImpl(`${cfg.url}/rest/v1/showroom_snapshot?on_conflict=id`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(cfg.key),
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ id: 1, generated_at: snap.generatedAt, payload: snap }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Supabase publish failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const companies = (snap.status?.companies as unknown[] | undefined)?.length ?? 0;
  return `Published ${companies} companies to Supabase (${(JSON.stringify(snap).length / 1024).toFixed(0)} KB).`;
}

/** Best-effort publish after agent runs; failures are logged, never thrown. */
export async function publishAfterRun() {
  if (!supabaseWriteConfig()) return;
  try {
    console.log(`[showroom] ${await publishSnapshot()}`);
  } catch (err) {
    console.error(`[showroom] ${(err as Error).message}`);
  }
}
