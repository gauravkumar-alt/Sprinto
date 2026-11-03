/** Sign in (POST {password}) and sign out (DELETE). Only active when APP_PASSWORD is set. */
import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { SESSION_COOKIE, SESSION_TTL_MS, createSessionToken, passwordMatches } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({ password: z.string().max(200) });

function cookieOptions(req: Request) {
  const https = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
  return { httpOnly: true, sameSite: "strict" as const, secure: https, path: "/" };
}

export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD ?? "";
  if (!password) return NextResponse.json({ error: "Sign-in is not enabled (APP_PASSWORD is not set)." }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !(await passwordMatches(parsed.data.password, password))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(password), { ...cookieOptions(req), maxAge: SESSION_TTL_MS / 1000 });
  return res;
}

export async function DELETE(req: Request) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(req), maxAge: 0 });
  return res;
}
