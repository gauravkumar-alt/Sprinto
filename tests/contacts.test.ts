import { beforeEach, describe, expect, it } from "vitest";
import { companyScale, rankContacts } from "@/lib/pipeline/contactRanking";
import { HunterContactProvider, mapHunterEmail } from "@/lib/providers/contact/hunter";
import { ContactProviderError } from "@/lib/providers/contact/types";
import type { ContactCandidate } from "@/lib/schemas";
import { freshDb } from "./helpers";

const person = (name: string, title: string | null, o: Partial<ContactCandidate> = {}): ContactCandidate => ({
  name,
  firstName: name.split(" ")[0],
  lastName: name.split(" ")[1] ?? null,
  title,
  department: null,
  seniority: null,
  email: `${name.split(" ")[0].toLowerCase()}@acme.com`,
  emailType: "personal",
  verificationStatus: "valid",
  providerConfidence: 90,
  sources: [],
  provider: "hunter",
  dataSource: "real",
  ...o,
});

describe("contact ranking", () => {
  it("13. ranks security/compliance owners above unrelated senior people", () => {
    const r = rankContacts([person("Ann Ceo", "CEO"), person("Ben Mkt", "VP Marketing"), person("Cara Sec", "Head of Security")], { scale: "growth", domain: "acme.com" });
    expect(r[0].candidate.name).toBe("Cara Sec");
    expect(r.find((x) => x.candidate.name === "Ben Mkt")!.eligible).toBe(false);
  });

  it("14. selects the right role for the company stage", () => {
    const people = [person("Ann Founder", "Co-founder & CEO"), person("Tom Cto", "CTO"), person("Sam Sec", "Security Engineer")];
    expect(rankContacts(people, { scale: "early", domain: "acme.com" })[0].candidate.name).toBe("Tom Cto");
    const large = [person("Ann Founder", "CEO"), person("Cleo Ciso", "Chief Information Security Officer"), person("Tom Cto", "CTO")];
    expect(rankContacts(large, { scale: "large", domain: "acme.com" })[0].candidate.name).toBe("Cleo Ciso");
    expect(companyScale("Series A", null)).toBe("early");
    expect(companyScale("Unknown", "1,200 employees")).toBe("large");
  });

  it("15. handles missing contacts and missing names without fabricating", () => {
    expect(rankContacts([], { scale: "growth", domain: "acme.com" })).toEqual([]);
    const r = rankContacts([person("", "CTO", { firstName: null, name: null })], { scale: "growth", domain: "acme.com" });
    expect(r[0].eligible).toBe(false);
  });

  it("16. invalid or missing emails make a contact ineligible", () => {
    const r = rankContacts(
      [person("Ivy Invalid", "CTO", { verificationStatus: "invalid" }), person("Mo Missing", "CISO", { email: null }), person("Gen Eric", "CTO", { emailType: "generic" })],
      { scale: "growth", domain: "acme.com" },
    );
    expect(r.every((x) => !x.eligible)).toBe(true);
  });

  it("maps Hunter responses without assuming fields exist", () => {
    const c = mapHunterEmail({ value: "x@acme.com", first_name: null, last_name: null, position: null, verification: null });
    expect(c.name).toBeNull();
    expect(c.title).toBeNull();
    expect(c.verificationStatus).toBeNull();
  });
});

describe("Hunter provider", () => {
  beforeEach(() => freshDb());

  it("17. surfaces rate limiting / quota as a typed error and counts usage", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ id: "too_many_requests", details: "You have reached your usage limit" }] }), { status: 429 });
    }) as unknown as typeof fetch;
    const p = new HunterContactProvider("k", fakeFetch);
    await expect(p.domainSearch("acme.com")).rejects.toBeInstanceOf(ContactProviderError);
    expect(calls).toBe(1);
  });

  it("17b. enforces the monthly limit locally and caches results", async () => {
    process.env.HUNTER_MONTHLY_LIMIT = "1";
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: { organization: "Acme", emails: [{ value: "a@acme.com", first_name: "A", last_name: "B", position: "CTO", verification: { status: "valid" } }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new HunterContactProvider("k", ok);
    const first = await p.domainSearch("acme.com");
    expect(first.candidates[0].title).toBe("CTO");
    const cached = await p.domainSearch("acme.com"); // served from cache, no extra request
    expect(cached.fromCache).toBe(true);
    expect(calls).toBe(1);
    await expect(p.domainSearch("other.com")).rejects.toThrow(/monthly limit/);
    delete process.env.HUNTER_MONTHLY_LIMIT;
  });
});
