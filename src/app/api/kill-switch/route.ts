import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { isShowroom } from "@/lib/showroom";

export const dynamic = "force-dynamic";

const Body = z.object({ on: z.boolean() });

export async function GET() {
  if (isShowroom()) return NextResponse.json({ on: false, forced: false });
  const { killSwitchOn, killSwitchForcedByEnv } = await import("@/lib/kill-switch");
  return NextResponse.json({ on: killSwitchOn(), forced: killSwitchForcedByEnv() });
}

/** Switch the kill switch on or off (localhost only: the middleware blocks POSTs from shared links). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send {\"on\": true} or {\"on\": false}." }, { status: 400 });
  const { killSwitchForcedByEnv, setKillSwitch } = await import("@/lib/kill-switch");
  if (!parsed.data.on && killSwitchForcedByEnv()) {
    return NextResponse.json({ error: "AGENT_KILL_SWITCH=true is set in the environment; remove it and restart to resume." }, { status: 409 });
  }
  return NextResponse.json(setKillSwitch(parsed.data.on));
}
