import { NextResponse } from "next/server";
import { isShowroom } from "@/lib/showroom";

export const dynamic = "force-dynamic";

/** Suggested companies and the progress of the current screen. */
export async function GET() {
  // The public snapshot has no database; suggestions only exist on the machine running the agent.
  if (isShowroom()) return NextResponse.json({ running: false, screened: 0, total: 0, error: null, lastRunAt: null, counts: {}, items: [] });
  const { discoveryStatus } = await import("@/lib/discovery");
  return NextResponse.json(discoveryStatus());
}

/** Screen the next batch of candidates (localhost only: the middleware blocks POSTs from shared links). */
export async function POST() {
  const { startDiscovery, discoveryStatus } = await import("@/lib/discovery");
  const { started } = startDiscovery(20);
  return NextResponse.json({ started, ...discoveryStatus() }, { status: started ? 202 : 409 });
}
