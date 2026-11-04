/** The qualification result in the required JSON output format. */
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { qualificationReport } from "@/lib/report";
import * as repo from "@/lib/repo";
import { isRemoteViewer, maskPayload } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const company = getDb().prepare("SELECT domain, name FROM companies WHERE id=?").get(id) as { domain: string; name: string | null } | undefined;
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = repo.latestQualification(id);
  if (!q) return NextResponse.json({ error: "Not assessed yet" }, { status: 404 });
  if (!q.categories) return NextResponse.json({ error: "Assessed with the previous rubric — re-run this company to generate the 100-point breakdown." }, { status: 409 });
  const report = qualificationReport(q, company.domain, company.name);
  return NextResponse.json(isRemoteViewer(req) ? maskPayload(report) : report, { headers: { "content-disposition": `inline; filename="${company.domain}-qualification.json"` } });
}
