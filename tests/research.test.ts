import { describe, expect, it } from "vitest";
import { condensePages, condenseText, pageType } from "@/lib/pipeline/research";
import { parseDomainCsv, parseDomainList } from "@/lib/security/domain";

describe("content condensing (~2,000 tokens per company)", () => {
  const page = [
    "Home Pricing Blog Login",
    "Accept all cookies to continue browsing our website today.",
    "Acme is a SaaS platform for finance teams at growing businesses.",
    "We are preparing for our SOC 2 Type II audit this year.",
    ...Array.from({ length: 200 }, (_, i) => `Filler marketing sentence number ${i} about our wonderful culture and values.`),
    "We have 7 open roles, including a Security Engineer.",
  ].join("\n");

  it("keeps signal lines verbatim and stays within budget", () => {
    const out = condenseText(page, 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("We are preparing for our SOC 2 Type II audit this year.");
    expect(out).toContain("We have 7 open roles, including a Security Engineer.");
    expect(out).toContain("Acme is a SaaS platform for finance teams at growing businesses.");
    expect(out).not.toContain("Accept all cookies");
  });

  it("splits a total budget across pages", () => {
    const out = condensePages([{ text: page }, { text: page }], 4000);
    expect(out.every((p) => p.condensed.length <= 2000)).toBe(true);
  });

  it("detects page types used for targeted research", () => {
    expect(pageType("https://acme.com/careers", "acme.com")).toBe("hiring");
    expect(pageType("https://acme.com/security", "acme.com")).toBe("security/compliance");
    expect(pageType("https://trust.acme.com/", "acme.com")).toBe("security/compliance");
    expect(pageType("https://acme.com/pricing", "acme.com")).toBe("pricing");
  });
});

describe("optional company name in the input", () => {
  it("accepts 'Name | domain' lines and a CSV name column", () => {
    expect(parseDomainList("Acme Inc | acme.com\nglobex.io").valid).toEqual([
      { input: "acme.com", domain: "acme.com", name: "Acme Inc" },
      { input: "globex.io", domain: "globex.io" },
    ]);
    const c = parseDomainCsv("company_name,website\nAcme Inc,https://acme.com\n,globex.io");
    expect(c.valid).toEqual([
      { input: "https://acme.com", domain: "acme.com", name: "Acme Inc" },
      { input: "globex.io", domain: "globex.io" },
    ]);
  });
});
