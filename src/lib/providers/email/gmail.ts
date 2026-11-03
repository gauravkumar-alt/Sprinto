/**
 * Gmail delivery (server-side OAuth 2.0). Scopes: gmail.send (send only) plus
 * openid/email so the authenticated address can be verified before sending.
 */
import { getConfig } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import { buildMime, toBase64Url } from "./mime";
import { assertIdentityMatchesInbox, assertMessageSafe, RecipientViolation } from "./recipientGuard";
import { EmailSendError, type EmailProvider, type OutgoingEmail, type SendResult } from "./types";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email"];

export function getStoredRefreshToken(): string {
  const env = getConfig().gmail.refreshToken;
  if (env) return env;
  const row = getDb().prepare("SELECT value FROM settings WHERE key='gmail_refresh_token'").get() as { value: string } | undefined;
  return row?.value ?? "";
}

export function storeRefreshToken(token: string, email: string) {
  const db = getDb();
  const up = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  );
  up.run("gmail_refresh_token", token, nowIso());
  up.run("gmail_authorized_email", email, nowIso());
}

export class GmailEmailProvider implements EmailProvider {
  readonly name = "gmail";
  readonly dataSource = "real" as const;
  private cfg = getConfig();
  private token: { value: string; exp: number } | null = null;
  private verified: string | null = null;

  constructor(private fetchImpl: typeof fetch = fetch) {}

  get deliveryRecipient() {
    return this.cfg.demoInboxEmail;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const { clientId, clientSecret } = this.cfg.gmail;
    const refreshToken = getStoredRefreshToken();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new EmailSendError("Gmail is not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and a refresh token are required).", "config");
    }
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new EmailSendError(
        `Gmail authentication failed (${json.error ?? res.status}${json.error_description ? ": " + json.error_description : ""}). The refresh token may be expired or revoked — re-run the Gmail authorisation.`,
        "auth",
      );
    }
    this.token = { value: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  async verifyIdentity(): Promise<{ authenticatedEmail: string }> {
    const at = await this.accessToken();
    const res = await this.fetchImpl(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(at)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const info = (await res.json().catch(() => ({}))) as { email?: string; email_verified?: string | boolean; scope?: string };
    if (!res.ok || !info.email) {
      throw new EmailSendError("Could not verify the authenticated Gmail account (token lacks the 'email' scope?). Re-authorise Gmail.", "auth");
    }
    if (String(info.email_verified) !== "true") throw new EmailSendError("The authenticated Google account email is not verified.", "auth");
    if (!info.scope?.includes("gmail.send")) throw new EmailSendError("The Gmail token does not include the gmail.send scope.", "auth");
    try {
      assertIdentityMatchesInbox({ authenticatedEmail: info.email, demoInbox: this.cfg.demoInboxEmail, configuredSender: this.cfg.gmail.senderEmail });
    } catch (e) {
      throw new EmailSendError((e as Error).message, "recipient");
    }
    this.verified = info.email.toLowerCase();
    return { authenticatedEmail: this.verified };
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const { authenticatedEmail } = await this.verifyIdentity(); // verified before every send
    const recipient = this.cfg.demoInboxEmail;
    const raw = buildMime({ fromName: this.cfg.senderName, fromEmail: authenticatedEmail, to: recipient, subject: email.subject, body: email.body });
    try {
      assertMessageSafe(raw, { demoInbox: recipient, prospectEmails: email.prospectEmails });
    } catch (e) {
      if (e instanceof RecipientViolation) throw new EmailSendError(e.message, "recipient");
      throw e;
    }
    const at = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: toBase64Url(raw) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // The request may or may not have reached Gmail. Never retry blindly.
      throw new EmailSendError(`Network error/timeout while sending — delivery outcome unknown: ${(err as Error).message}`, "timeout");
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string; error?: { message?: string } };
    if (res.status === 401 || res.status === 403) throw new EmailSendError(`Gmail refused the send (${res.status}): ${json.error?.message ?? ""}`, "auth");
    // A 5xx, or a 2xx without a message id, may still have been delivered: treat as unknown, never as a plain failure.
    if (res.status >= 500 || (res.ok && !json.id)) {
      throw new EmailSendError(`Gmail returned ${res.status}${json.id ? "" : " without a message id"} — delivery outcome unknown`, "timeout");
    }
    if (!res.ok || !json.id) throw new EmailSendError(`Gmail API error ${res.status}: ${json.error?.message ?? "no message id returned"}`, "api");
    return { status: "sent", messageId: json.id, threadId: json.threadId ?? null, recipient };
  }
}
