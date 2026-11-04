import { afterEach, describe, expect, it } from "vitest";
import { decideQualification, finalizeUnresolved, researchTargets, type EvidenceLite } from "@/lib/pipeline/qualification";
import { qualificationReport } from "@/lib/report";
import { findings } from "./helpers";

const ev: EvidenceLite[] = [
  { ref: "E1", type: "observed", text: "Acme is a cloud SaaS platform billed per seat", url: "https://acme.com/" },
  { ref: "E2", type: "observed", text: "Built for finance teams at growing businesses", url: "https://acme.com/" },
  { ref: "E3", type: "observed", text: "Acme raised a $20M Series B", url: "https://acme.com/press" },
  { ref: "E4", type: "observed", text: "We have 7 open roles across the company", url: "https://acme.com/careers" },
  { ref: "E5", type: "observed", text: "Enterprise plan with SSO and audit logs", url: "https://acme.com/pricing" },
  { ref: "E6", type: "observed", text: "We are preparing for our SOC 2 Type II audit", url: "https://acme.com/security" },
  { ref: "E7", type: "observed", text: "We're hiring a Security & Compliance Engineer", url: "https://acme.com/careers" },
  { ref: "E8", type: "observed", text: "Enterprise customers send us security questionnaires during procurement", url: "https://acme.com/security" },
  { ref: "E9", type: "observed", text: "Customers include Contoso Bank and Northwind", url: "https://acme.com/customers" },
  { ref: "E10", type: "observed", text: "Built for large enterprises and global teams", url: "https://acme.com/" },
  { ref: "E11", type: "observed", text: "We are an IT consulting and staffing firm", url: "https://acme.com/about" },
  { ref: "E12", type: "observed", text: "Acme is SOC 2 Type II certified", url: "https://acme.com/security" },
  { ref: "E13", type: "inference", text: "The company appears to prepare for SOC 2", url: null },
  { ref: "E14", type: "observed", text: "Shop our collection made for consumers", url: "https://acme.com/" },
  { ref: "E15", type: "observed", text: "We take security seriously", url: "https://acme.com/security" },
];
const ALL = new Set(["homepage", "product", "pricing", "about", "customers", "funding/news", "hiring", "enterprise", "security/compliance"]);
const BIZ = { saas: ["E1"], b2b: ["E2"], product: ["E1"] };
const EVERYTHING = {
  ...BIZ,
  funding_series_ac: ["E3"],
  open_roles: ["E4"],
  enterprise_pricing: ["E5"],
  preparing_certification: ["E6"],
  compliance_hiring: ["E7"],
  enterprise_security_reviews: ["E8"],
  named_enterprise_customers: ["E9"],
  targets_enterprise: ["E10"],
};
const decide = (f: ReturnType<typeof findings>, checked = ALL, canResearchMore = false) =>
  decideQualification({ findings: f, evidence: ev, checkedPages: checked, pagesScraped: ["https://acme.com/"], canResearchMore });
const saasB2B = { is_saas: "yes" as const, audience: "b2b" as const };

describe("100-point rubric", () => {
  afterEach(() => {
    delete process.env.QUALIFY_THRESHOLD;
    delete process.env.REVIEW_THRESHOLD;
  });

  it("scores each category and criterion deterministically (30 / 25 / 35 / 10)", () => {
    const r = decide(findings({ ...saasB2B, open_roles_count: 7, found: EVERYTHING }));
    expect(r.fit_score).toBe(100);
    expect(r.categories.business_model_fit.score).toBe(30);
    expect(r.categories.growth_stage.score).toBe(25);
    expect(r.categories.compliance_buying_signals.score).toBe(35);
    expect(r.categories.enterprise_readiness.score).toBe(10);
    expect(r.decision).toBe("qualified");
    expect(decide(findings({ ...saasB2B, open_roles_count: 7, found: EVERYTHING }))).toEqual(r);
  });

  it("stores criterion name, max, points, evidence text, source URL, confidence and status", () => {
    const r = decide(findings({ ...saasB2B, found: { ...BIZ, preparing_certification: ["E6"] } }));
    const c = r.categories.compliance_buying_signals.criteria.find((x) => x.id === "preparing_certification")!;
    expect(c).toMatchObject({ max_points: 20, points: 20, status: "FOUND" });
    expect(c.evidence[0]).toMatchObject({ ref: "E6", source_url: "https://acme.com/security" });
    expect(c.confidence).toBeGreaterThan(0);
  });

  it("distinguishes NOT_FOUND (page checked) from UNKNOWN (no relevant page checked)", () => {
    const checked = new Set(["homepage", "hiring"]);
    const r = decide(findings({ ...saasB2B, found: BIZ }), checked);
    const growth = r.categories.growth_stage.criteria;
    expect(growth.find((x) => x.id === "open_roles")!.status).toBe("NOT_FOUND");
    expect(growth.find((x) => x.id === "funding_series_ac")!.status).toBe("UNKNOWN");
  });

  it("never awards points for weak or inferred evidence", () => {
    const r = decide(findings({ ...saasB2B, found: { ...BIZ, preparing_certification: ["E15"], compliance_hiring: ["E13"], funding_series_ac: ["E1"] } }));
    expect(r.categories.compliance_buying_signals.score).toBe(0);
    expect(r.categories.growth_stage.score).toBe(0);
    expect(r.adjustments.length).toBeGreaterThanOrEqual(3);
  });

  it("requires 5+ open roles for the hiring-growth points", () => {
    const r = decide(findings({ ...saasB2B, open_roles_count: 3, found: { ...BIZ, open_roles: ["E4"] } }));
    expect(r.categories.growth_stage.criteria.find((x) => x.id === "open_roles")!.points).toBe(0);
  });
});

describe("real-world wording (regressions from live runs)", () => {
  const live: EvidenceLite[] = [
    { ref: "L1", type: "observed", text: "Compliance and certifications EU GDPR Compliant SOC II PENDING", url: "https://reflag.com/security" },
    { ref: "L2", type: "observed", text: "Try our free plan. No credit card required", url: "https://documenso.com/" },
    { ref: "L3", type: "observed", text: "We are SOC II Type 2 certified", url: "https://x.com/security" },
    { ref: "L4", type: "observed", text: "Built for product teams at SaaS companies", url: "https://reflag.com/" },
  ];
  const run = (f: ReturnType<typeof findings>) => decideQualification({ findings: f, evidence: live, checkedPages: ALL, pagesScraped: [], canResearchMore: false });

  it("recognises 'SOC II … PENDING' as preparing for certification", () => {
    const r = run(findings({ ...saasB2B, found: { saas: ["L4"], b2b: ["L4"], preparing_certification: ["L1"] } }));
    expect(r.categories.compliance_buying_signals.criteria.find((c) => c.id === "preparing_certification")!.status).toBe("FOUND");
  });

  it("recognises self-serve plan wording as SaaS evidence", () => {
    const r = run(findings({ ...saasB2B, found: { saas: ["L2"] } }));
    expect(r.categories.business_model_fit.criteria.find((c) => c.id === "saas")!.status).toBe("FOUND");
  });

  it("treats 'SOC II … certified' as an existing certification", () => {
    const r = run(findings({ ...saasB2B, found: { saas: ["L4"], b2b: ["L4"] }, existing_certifications: [{ name: "SOC 2", evidence_ids: ["L3"] }] }));
    expect(r.flags).toContain("ALREADY_CERTIFIED");
  });
});

describe("disqualification rules (take priority over the score)", () => {
  it("disqualifies a non-SaaS business", () => {
    const r = decide(findings({ is_saas: "no", audience: "b2b", found: { saas: ["E11"], preparing_certification: ["E6"], compliance_hiring: ["E7"] } }));
    expect(r.decision).toBe("not_qualified");
    expect(r.disqualification_reasons[0]).toMatch(/Not a SaaS/);
  });

  it("disqualifies B2C-only companies", () => {
    const r = decide(findings({ is_saas: "yes", audience: "b2c", found: { saas: ["E1"], b2b: ["E14"] } }));
    expect(r.decision).toBe("not_qualified");
    expect(r.disqualification_reasons[0]).toMatch(/B2C/);
  });

  it("flags ALREADY_CERTIFIED and disqualifies, even with a high score", () => {
    const r = decide(findings({ ...saasB2B, open_roles_count: 7, found: EVERYTHING, existing_certifications: [{ name: "SOC 2", evidence_ids: ["E12"] }] }));
    expect(r.fit_score).toBe(100);
    expect(r.flags).toContain("ALREADY_CERTIFIED");
    expect(r.decision).toBe("not_qualified");
  });

  it("does not treat a planned certification as held", () => {
    const r = decide(findings({ ...saasB2B, found: BIZ, existing_certifications: [{ name: "SOC 2", evidence_ids: ["E6"] }] }));
    expect(r.flags).not.toContain("ALREADY_CERTIFIED");
  });

  it("returns NEEDS_REVIEW when the business model cannot be established", () => {
    expect(decide(findings({ found: { preparing_certification: ["E6"] } })).decision).toBe("needs_review");
    expect(decide(findings({ found: { preparing_certification: ["E6"] } }), ALL, true).decision).toBe("research_more");
  });

  it("a high score never overrides a missing B2B requirement", () => {
    const { b2b: _b2b, ...rest } = EVERYTHING;
    void _b2b;
    const r = decide(findings({ is_saas: "yes", audience: "unknown", open_roles_count: 7, found: rest }));
    expect(r.fit_score).toBe(90);
    expect(r.decision).toBe("needs_review");
  });

  it("missing information is not treated as unsuitable", () => {
    // 30 points and no compliance pages could be checked → review, not rejection.
    const r = decide(findings({ ...saasB2B, found: BIZ }), new Set(["homepage"]));
    expect(r.decision).toBe("needs_review");
    expect(r.missing_information.join(" ")).toMatch(/compliance/i);
  });
});

describe("thresholds", () => {
  afterEach(() => {
    delete process.env.QUALIFY_THRESHOLD;
    delete process.env.REVIEW_THRESHOLD;
  });
  const score = (found: Record<string, string[]>) => decide(findings({ ...saasB2B, found: { ...BIZ, ...found } }));

  it("75+ qualified, 55–74 needs review, below 55 not qualified", () => {
    const top = { preparing_certification: ["E6"], compliance_hiring: ["E7"], enterprise_security_reviews: ["E8"], named_enterprise_customers: ["E9"], targets_enterprise: ["E10"] };
    expect(score(top).fit_score).toBe(75);
    expect(score(top).decision).toBe("qualified");
    const mid = score({ preparing_certification: ["E6"], compliance_hiring: ["E7"] });
    expect(mid.fit_score).toBe(60);
    expect(mid.decision).toBe("needs_review");
    const low = score({ targets_enterprise: ["E10"] });
    expect(low.fit_score).toBe(35);
    expect(low.decision).toBe("not_qualified");
  });

  it("thresholds are configurable", () => {
    process.env.QUALIFY_THRESHOLD = "60";
    expect(score({ preparing_certification: ["E6"], compliance_hiring: ["E7"] }).decision).toBe("qualified");
  });

  it("checks certification status before qualifying when research budget remains", () => {
    const r = decide(findings({ ...saasB2B, open_roles_count: 7, found: { ...BIZ, funding_series_ac: ["E3"], open_roles: ["E4"], enterprise_pricing: ["E5"], compliance_hiring: ["E7"], targets_enterprise: ["E10"], named_enterprise_customers: ["E9"] } }), new Set(["homepage", "hiring", "pricing", "funding/news"]), true);
    expect(r.fit_score).toBe(75);
    expect(r.decision).toBe("research_more");
    expect(researchTargets(r, new Set(["homepage", "hiring", "pricing", "funding/news"]))).toContain("security/compliance");
  });
});

describe("targeted research", () => {
  it("fetches the page most likely to answer each open question", () => {
    const r = decide(findings({ found: {} }), new Set(["homepage"]), true);
    const t = researchTargets(r, new Set(["homepage"]));
    expect(t.slice(0, 2)).toEqual(["product", "about"]);
    expect(t).toContain("security/compliance");
    expect(t).toContain("hiring");
  });

  it("an unresolved case becomes NEEDS_REVIEW when the research limit is reached", () => {
    const r = finalizeUnresolved(decide(findings({ found: {} }), new Set(["homepage"]), true));
    expect(r.decision).toBe("needs_review");
    expect(r.explanation).toMatch(/Research limit reached/);
  });
});

describe("required output format", () => {
  it("produces the spec JSON with every field", () => {
    const r = decide(findings({ ...saasB2B, found: { ...BIZ, preparing_certification: ["E6"] } }));
    const out = qualificationReport(r, "acme.com", "Acme");
    expect(Object.keys(out)).toEqual([
      "company_name",
      "domain",
      "business_description",
      "total_score",
      "qualification_status",
      "business_model_fit",
      "growth_stage",
      "compliance_buying_signals",
      "enterprise_readiness",
      "existing_certifications",
      "disqualification_reasons",
      "missing_information",
      "pages_scraped",
      "research_summary",
      "recommended_next_action",
    ]);
    expect(out.compliance_buying_signals.score).toBe(20);
    expect(out.compliance_buying_signals.evidence[0]).toMatchObject({ criterion: expect.any(String), status: "FOUND", points_awarded: 20 });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
