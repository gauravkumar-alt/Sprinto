/** Starts the server-side Google OAuth flow (gmail.send + openid email). */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { GMAIL_SCOPES } from "@/lib/providers/email/gmail";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = getConfig();
  if (!cfg.gmail.clientId || !cfg.gmail.clientSecret) {
    return NextResponse.json({ error: "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env.local first." }, { status: 400 });
  }
  if (!cfg.demoInboxEmail) return NextResponse.json({ error: "Set DEMO_INBOX_EMAIL in .env.local first." }, { status: 400 });
  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.gmail.clientId);
  url.searchParams.set("redirect_uri", cfg.gmail.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("login_hint", cfg.demoInboxEmail);
  url.searchParams.set("state", state);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set("gmail_oauth_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/api/auth/gmail" });
  return res;
}
