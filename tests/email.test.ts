import { beforeEach, describe, expect, it } from "vitest";
import { buildMime } from "@/lib/providers/email/mime";
import { GmailEmailProvider } from "@/lib/providers/email/gmail";
import { MockEmailProvider } from "@/lib/providers/email/mock";
import { assertIdentityMatchesInbox, assertMessageSafe, RecipientViolation } from "@/lib/providers/email/recipientGuard";
import { EmailSendError } from "@/lib/providers/email/types";
import { freshDb } from "./helpers";

const INBOX = "me@inbox.test";
const mime = (to: string, extra = "", body = "Hi Jane,\nhello") =>
  buildMime({ fromName: "Me", fromEmail: INBOX, to, subject: "S", body }).replace("MIME-Version", `${extra}MIME-Version`);

describe("recipient guard", () => {
  it("27. allows exactly the demo inbox as recipient", () => {
    expect(() => assertMessageSafe(mime(INBOX), { demoInbox: INBOX, prospectEmails: ["jane@acme.com"] })).not.toThrow();
    expect(() => assertMessageSafe(mime("jane@acme.com"), { demoInbox: INBOX, prospectEmails: [] })).toThrow(RecipientViolation);
  });

  it("28. prospect never appears in To, Cc, Bcc or anywhere in the message", () => {
    expect(() => assertMessageSafe(mime(INBOX, "Cc: jane@acme.com\r\n"), { demoInbox: INBOX, prospectEmails: ["jane@acme.com"] })).toThrow(/cc/);
    expect(() => assertMessageSafe(mime(INBOX, "Bcc: x@y.com\r\n"), { demoInbox: INBOX, prospectEmails: [] })).toThrow(/bcc/);
    expect(() => assertMessageSafe(mime(INBOX, "", "Hi Jane, reach me at jane@acme.com"), { demoInbox: INBOX, prospectEmails: ["jane@acme.com"] })).toThrow(/prospect/);
    const two = buildMime({ fromName: "Me", fromEmail: INBOX, to: INBOX, subject: "S", body: "b" }).replace(`To: <${INBOX}>`, `To: <${INBOX}>, <jane@acme.com>`);
    expect(() => assertMessageSafe(two, { demoInbox: INBOX, prospectEmails: [] })).toThrow(/exactly/);
  });

  it("blocks when the authenticated account is not the demo inbox, or the inbox is unset", () => {
    expect(() => assertIdentityMatchesInbox({ authenticatedEmail: "other@gmail.com", demoInbox: INBOX })).toThrow(/does not match/);
    expect(() => assertIdentityMatchesInbox({ authenticatedEmail: INBOX, demoInbox: "" })).toThrow(/not set/);
    expect(() => assertIdentityMatchesInbox({ authenticatedEmail: "ME@inbox.test", demoInbox: INBOX })).not.toThrow();
  });

  it("finds prospect addresses hidden in RFC 2047-encoded (non-ASCII) subjects", () => {
    const raw = buildMime({ fromName: "Me", fromEmail: INBOX, to: INBOX, subject: "Héllo — jane@acme.com", body: "b" });
    expect(raw).not.toContain("jane@acme.com"); // the subject is base64-encoded on the wire
    expect(() => assertMessageSafe(raw, { demoInbox: INBOX, prospectEmails: ["jane@acme.com"] })).toThrow(/prospect/);
  });

  it("header injection via subject cannot add recipients", () => {
    const raw = buildMime({ fromName: "Me", fromEmail: INBOX, to: INBOX, subject: "Hi\r\nBcc: jane@acme.com", body: "b" });
    expect(() => assertMessageSafe(raw, { demoInbox: INBOX, prospectEmails: [] })).not.toThrow();
    expect(raw.split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/m);
  });
});

describe("Gmail provider", () => {
  beforeEach(() => {
    freshDb();
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    process.env.GMAIL_REFRESH_TOKEN = "refresh";
    process.env.DEMO_INBOX_EMAIL = INBOX;
  });

  function fakeGoogle(opts: { tokenOk?: boolean; email?: string; sendStatus?: number; sendThrows?: boolean }) {
    const sent: { url: string; body: string }[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        return opts.tokenOk === false
          ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 })
          : new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("tokeninfo")) return new Response(JSON.stringify({ email: opts.email ?? INBOX, email_verified: "true", scope: "https://www.googleapis.com/auth/gmail.send openid email" }), { status: 200 });
      if (u.includes("messages/send")) {
        if (opts.sendThrows) throw new Error("socket hang up");
        sent.push({ url: u, body: String(init?.body) });
        return opts.sendStatus && opts.sendStatus >= 400
          ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: opts.sendStatus })
          : new Response(JSON.stringify({ id: "msg123", threadId: "t1" }), { status: 200 });
      }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    return { f, sent };
  }

  it("27b. sends only to the verified inbox and returns Gmail's id", async () => {
    const { f, sent } = fakeGoogle({});
    const res = await new GmailEmailProvider(f).send({ subject: "Hello", body: "Hi Jane,\nbody", prospectEmails: ["jane@acme.com"] });
    expect(res).toMatchObject({ status: "sent", messageId: "msg123", recipient: INBOX });
    const raw = Buffer.from(JSON.parse(sent[0].body).raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(raw).toMatch(new RegExp(`^To: <${INBOX}>$`, "m"));
    expect(raw).not.toMatch(/jane@acme.com/);
    expect(raw).not.toMatch(/^(Cc|Bcc):/im);
  });

  it("29. authentication failure blocks sending", async () => {
    const { f, sent } = fakeGoogle({ tokenOk: false });
    await expect(new GmailEmailProvider(f).send({ subject: "s", body: "b", prospectEmails: [] })).rejects.toMatchObject({ kind: "auth" });
    expect(sent.length).toBe(0);
  });

  it("29b. a different authenticated Google account blocks sending", async () => {
    const { f, sent } = fakeGoogle({ email: "someone-else@gmail.com" });
    await expect(new GmailEmailProvider(f).send({ subject: "s", body: "b", prospectEmails: [] })).rejects.toMatchObject({ kind: "recipient" });
    expect(sent.length).toBe(0);
  });

  it("31. client errors are failures; 5xx and timeouts are 'outcome unknown' (may have been delivered)", async () => {
    await expect(new GmailEmailProvider(fakeGoogle({ sendStatus: 400 }).f).send({ subject: "s", body: "b", prospectEmails: [] })).rejects.toMatchObject({ kind: "api" });
    await expect(new GmailEmailProvider(fakeGoogle({ sendStatus: 500 }).f).send({ subject: "s", body: "b", prospectEmails: [] })).rejects.toMatchObject({ kind: "timeout" });
    const err = await new GmailEmailProvider(fakeGoogle({ sendThrows: true }).f).send({ subject: "s", body: "b", prospectEmails: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.kind).toBe("timeout");
  });

  it("32. mock send is SIMULATED, never SENT", async () => {
    const r = await new MockEmailProvider().send({ subject: "s", body: "Hi Jane", prospectEmails: ["jane@acme.com"] });
    expect(r.status).toBe("simulated");
    expect(r.messageId).toMatch(/^simulated-/);
  });
});
