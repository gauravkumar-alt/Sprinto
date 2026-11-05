import { NextResponse } from "next/server";
import { getSnapshot, isShowroom } from "@/lib/showroom";
import { isRemoteViewer, publicCompanyDetail } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (isShowroom()) {
    const detail = (await getSnapshot()).companies[id];
    return detail ? NextResponse.json({ ...detail, readOnly: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { recoverOnce } = await import("@/lib/pipeline/orchestrator");
  const { companyDetail } = await import("@/lib/queries");
  recoverOnce();
  const detail = companyDetail(Number(id));
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isRemoteViewer(req)) return NextResponse.json({ ...publicCompanyDetail(detail), readOnly: true });
  return NextResponse.json({ ...detail, readOnly: false });
}
