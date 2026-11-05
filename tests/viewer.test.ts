import { describe, expect, it } from "vitest";
import { hasFullEmail, isRemoteRequest, maskEmails, publicCompanyDetail } from "@/lib/viewer";

const h = (o: Record<string, string>) => new Headers(o);

describe("who is a remote viewer", () => {
  it("plain local requests are local", () => {
    expect(isRemoteRequest(h({ host: "localhost:3123" }))).toBe(false);
    expect(isRemoteRequest(h({ host: "127.0.0.1:3123", "x-forwarded-for": "127.0.0.1" }))).toBe(false);
  });
  it("a tunnel that rewrites Host to localhost is still remote", () => {
    expect(isRemoteRequest(h({ host: "localhost:3123", "cf-connecting-ip": "203.0.113.9" }))).toBe(true);
    expect(isRemoteRequest(h({ host: "localhost:3123", "x-forwarded-for": "203.0.113.9, 127.0.0.1" }))).toBe(true);
    expect(isRemoteRequest(h({ host: "localhost:3123", forwarded: 'for="[2001:db8::1]"' }))).toBe(true);
    expect(isRemoteRequest(h({ host: "localhost:3123", "x-forwarded-host": "abc.trycloudflare.com" }))).toBe(true);
    expect(isRemoteRequest(h({ host: "abc.trycloudflare.com" }))).toBe(true);
  });
});

describe("masking", () => {
  it("masks URL-encoded and apostrophe addresses", () => {
    expect(maskEmails("mailto:jane%40acme.com")).toBe("mailto:j•••@acme.com");
    expect(maskEmails("john.o'neil@acme.com")).toBe("j•••@acme.com");
    expect(hasFullEmail(maskEmails("a jane%40acme.com b john.o'neil@acme.com"))).toBe(false);
  });
});

describe("public company detail", () => {
  it("keeps only the selected contact's name/title, drops other people, contact evidence and Gmail ids", () => {
    const d = publicCompanyDetail({
      contacts: [
        { id: 1, name: "Lucas Smith", title: "CTO", business_email: "lucas@acme.com", selected: 1, rank_score: 0.9 },
        { id: 2, name: "Other Person", title: "Engineer", business_email: "other@acme.com", selected: 0 },
      ],
      evidence: [
        { ref: "E1", category: "company", source_type: "website", supporting_text: "SaaS" },
        { ref: "E2", category: "contact", source_type: "contact_provider", supporting_text: "Lucas Smith, CTO — lucas@acme.com" },
      ],
      sends: [{ id: 1, status: "sent", provider: "gmail", gmail_message_id: "abc", gmail_thread_id: "t", delivery_recipient: "me@x.com", completed_at: "2026" }],
    });
    const json = JSON.stringify(d);
    expect(json).not.toContain("Other Person");
    expect(json).not.toContain("lucas@");
    expect(json).not.toContain("gmail_message_id");
    expect((d.contacts as unknown[]).length).toBe(1);
    expect((d.evidence as unknown[]).length).toBe(1);
    expect(hasFullEmail(json)).toBe(false);
  });
});
