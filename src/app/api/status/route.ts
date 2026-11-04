import { NextResponse } from "next/server";
import { getSnapshot, isShowroom } from "@/lib/showroom";
import { isRemoteViewer, maskPayload } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (isShowroom()) {
    const snap = await getSnapshot();
    if (!snap.status) return NextResponse.json({ error: "No snapshot published yet." }, { status: 503 });
    return NextResponse.json({ ...snap.status, readOnly: true, snapshotAt: snap.generatedAt });
  }
  // Loaded only outside the showroom: the database and providers aren't available there.
  const { recoverOnce } = await import("@/lib/pipeline/orchestrator");
  const { providerStatus } = await import("@/lib/providers");
  const { dashboardMetrics, listCompanies, recentBatches } = await import("@/lib/queries");
  recoverOnce();
  const payload = { providers: providerStatus(), metrics: dashboardMetrics(), batches: recentBatches(), companies: listCompanies() };
  // Shared-link viewers get a read-only view with email addresses partly masked.
  if (isRemoteViewer(req)) return NextResponse.json({ ...maskPayload(payload), readOnly: true });
  return NextResponse.json({ ...payload, readOnly: false });
}
