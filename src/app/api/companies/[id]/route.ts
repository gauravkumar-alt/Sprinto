import { NextResponse } from "next/server";
import { recoverOnce } from "@/lib/pipeline/orchestrator";
import { companyDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  recoverOnce();
  const { id } = await params;
  const detail = companyDetail(Number(id));
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(detail);
}
