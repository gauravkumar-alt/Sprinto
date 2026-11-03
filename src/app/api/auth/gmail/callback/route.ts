/**
 * OAuth callback: exchanges the code server-side, verifies that the Google
 * account equals DEMO_INBOX_EMAIL, and only then stores the refresh token in the
 * local database (never sent to the browser).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { storeRefreshToken } from "@/lib/providers/email/gmail";
import { assertIdentityMatchesInbox } from "@/lib/providers/email/recipientGuard";

export const dynamic = "force-dynamic";

function page(title: string, msg: string, ok: boolean) {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;max-width:560px;margin:80px auto;color:#111">
<h2 style="color:${ok ? "#166534" : "#b91c1c"}">${title}</h2><p>${msg}</p><p><a href="/">Back to dashboard</a></p></body>`;
  return new NextResponse(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const err = req.nextUrl.searchParams.get("error");
  if (err) return page("Authorisation cancelled", esc(err), false);
  if (!code || !state || state !== req.cookies.get("gmail_oauth_state")?.value) return page("Invalid OAuth state", "Please start again from the dashboard.", false);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.gmail.clientId, client_secret: cfg.gmail.clientSecret, redirect_uri: cfg.gmail.redirectUri, grant_type: "authorization_code" }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!tokenRes.ok || !tok.access_token) return page("Token exchange failed", esc(tok.error ?? String(tokenRes.status)), false);
  if (!tok.refresh_token) return page("No refresh token returned", "Remove the app's access at myaccount.google.com/permissions and authorise again.", false);

  const info = (await (await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tok.access_token)}`)).json().catch(() => ({}))) as {
    email?: string;
    scope?: string;
  };
  try {
    assertIdentityMatchesInbox({ authenticatedEmail: info.email ?? null, demoInbox: cfg.demoInboxEmail, configuredSender: cfg.gmail.senderEmail });
  } catch (e) {
    return page("Wrong Google account", esc((e as Error).message) + " Nothing was stored.", false);
  }
  if (!info.scope?.includes("gmail.send")) return page("Missing permission", "The gmail.send permission was not granted. Nothing was stored.", false);

  storeRefreshToken(tok.refresh_token, info.email!.toLowerCase());
  const res = page("Gmail connected", `Authorised as <b>${esc(info.email!)}</b>. Emails will be delivered only to this inbox.`, true);
  res.cookies.delete("gmail_oauth_state");
  return res;
}
