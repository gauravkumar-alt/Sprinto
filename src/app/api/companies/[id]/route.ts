import { NextResponse } from "next/server";
import { recoverOnce } from "@/lib/pipeline/orchestrator";
import { companyDetail } from "@/lib/queries";
import { isRemoteViewer, maskPayload } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  recoverOnce();
  const { id } = await params;
  const detail = companyDetail(Number(id));
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isRemoteViewer(req)) return NextResponse.json({ ...maskPayload(detail), readOnly: true });
  return NextResponse.json({ ...detail, readOnly: false });
}
