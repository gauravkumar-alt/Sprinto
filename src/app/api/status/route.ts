import { NextResponse } from "next/server";
import { recoverOnce } from "@/lib/pipeline/orchestrator";
import { providerStatus } from "@/lib/providers";
import { dashboardMetrics, listCompanies, recentBatches } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  recoverOnce();
  return NextResponse.json({ providers: providerStatus(), metrics: dashboardMetrics(), batches: recentBatches(), companies: listCompanies() });
}
