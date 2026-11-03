import { NextResponse } from "next/server";
import { recoverOnce } from "@/lib/pipeline/orchestrator";
import { providerStatus } from "@/lib/providers";
import { dashboardMetrics, listCompanies, recentBatches } from "@/lib/queries";
import { isRemoteViewer, maskPayload } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  recoverOnce();
  const payload = { providers: providerStatus(), metrics: dashboardMetrics(), batches: recentBatches(), companies: listCompanies() };
  // Shared-link viewers get a read-only view with email addresses partly masked.
  if (isRemoteViewer(req)) return NextResponse.json({ ...maskPayload(payload), readOnly: true });
  return NextResponse.json({ ...payload, readOnly: false });
}
