/** The qualification result in the required JSON output format. */
import { NextResponse } from "next/server";
import { getSnapshot, isShowroom } from "@/lib/showroom";
import { isRemoteViewer, maskPayload } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const idStr = (await params).id;
  if (isShowroom()) {
    const report = (await getSnapshot()).qualification[idStr];
    return report ? NextResponse.json(report) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { getDb } = await import("@/lib/db");
  const { qualificationReport } = await import("@/lib/report");
  const repo = await import("@/lib/repo");
  const id = Number(idStr);
  const company = getDb().prepare("SELECT domain, name FROM companies WHERE id=?").get(id) as { domain: string; name: string | null } | undefined;
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = repo.latestQualification(id);
  if (!q) return NextResponse.json({ error: "Not assessed yet" }, { status: 404 });
  if (!q.categories) return NextResponse.json({ error: "Assessed with the previous rubric — re-run this company to generate the 100-point breakdown." }, { status: 409 });
  const report = qualificationReport(q, company.domain, company.name);
  return NextResponse.json(isRemoteViewer(req) ? maskPayload(report) : report, { headers: { "content-disposition": `inline; filename="${company.domain}-qualification.json"` } });
}
