import { describe, expect, it } from "vitest";
import { decideQualification, type EvidenceLite } from "@/lib/pipeline/qualification";
import { findings } from "./helpers";

const ALL = new Set(["homepage", "product", "pricing", "about", "customers", "funding/news", "hiring", "enterprise", "security/compliance"]);
const base: EvidenceLite[] = [
  { ref: "E1", type: "observed", text: "Acme is a cloud SaaS platform billed per seat", url: "https://acme.com/" },
  { ref: "E2", type: "observed", text: "Built for finance teams at growing businesses", url: "https://acme.com/" },
];
const saasB2B = { is_saas: "yes" as const, audience: "b2b" as const };

function run(text: string, opts: { cert?: boolean; prep?: boolean } = {}, extra: EvidenceLite[] = [], found: Record<string, string[]> = {}) {
  const evidence = [...base, { ref: "E9", type: "observed" as const, text, url: "https://acme.com/security" }, ...extra];
  return decideQualification({
    findings: findings({
      ...saasB2B,
      found: { saas: ["E1"], b2b: ["E2"], product: ["E1"], ...(opts.prep ? { preparing_certification: ["E9"] } : {}), ...found },
      existing_certifications: opts.cert ? [{ name: "SOC 2", evidence_ids: ["E9"] }] : [],
    }),
    evidence,
    checkedPages: ALL,
    pagesScraped: ["https://acme.com/"],
    canResearchMore: false,
  });
}
const prepStatus = (r: ReturnType<typeof run>) => r.categories.compliance_buying_signals.criteria.find((c) => c.id === "preparing_certification")!.status;

describe("certification wording", () => {
  it.each([
    "Acme is not yet SOC 2 certified; our audit is underway",
    "We don't have a SOC 2 report yet",
    "Acme isn't SOC 2 compliant today",
    "We have no SOC 2 certification at this time",
    "Our customers need to become SOC 2 certified",
  ])("negated: %s → not ALREADY_CERTIFIED", (text) => {
    expect(run(text, { cert: true }).flags).not.toContain("ALREADY_CERTIFIED");
  });

  it.each(["We are not just compliant: Acme is SOC 2 Type II certified", "Acme is SOC 2 Type II certified and audited annually", "Acme holds ISO 27001 certification"])(
    "held: %s → ALREADY_CERTIFIED",
    (text) => {
      expect(run(text, { cert: true }).flags).toContain("ALREADY_CERTIFIED");
    },
  );

  it("a vendor that helps others get SOC 2 is neither certified nor preparing", () => {
    const r = run("Acme helps startups get SOC 2 certified in weeks and prepare for your SOC 2 audit", { cert: true, prep: true });
    expect(r.flags).not.toContain("ALREADY_CERTIFIED");
    expect(prepStatus(r)).not.toBe("FOUND");
  });

  it("'SOC 2 coming soon' and 'not yet certified, audit underway' count as preparing", () => {
    expect(prepStatus(run("SOC 2 Type II: coming soon, our audit kicks off next month", { prep: true }))).toBe("FOUND");
    expect(prepStatus(run("Acme is not yet SOC 2 certified; our audit is underway", { prep: true }))).toBe("FOUND");
  });
});

describe("funding from third-party articles", () => {
  const article: EvidenceLite = { ref: "E20", type: "inference", text: "Third-party source reports: Acme raised a Series B. Acme has raised a $30M Series B led by Accel.", url: "https://news.example/acme" };
  const fundingStatus = (r: ReturnType<typeof run>) => r.categories.growth_stage.criteria.find((c) => c.id === "funding_series_ac")!;

  it("a verbatim quote from a fetched article counts, labelled as third-party", () => {
    const r = run("We take security seriously", {}, [article], { funding_series_ac: ["E20"] });
    expect(fundingStatus(r).status).toBe("FOUND");
    expect(r.adjustments.join(" ")).toMatch(/third-party article/);
  });

  it("a model inference (not an article quote) still does not count", () => {
    const guess: EvidenceLite = { ref: "E21", type: "inference", text: "The company probably raised a Series A", url: null };
    const r = run("We take security seriously", {}, [guess], { funding_series_ac: ["E21"] });
    expect(fundingStatus(r).status).not.toBe("FOUND");
  });

  it("third-party pages can't satisfy any other criterion", () => {
    const t: EvidenceLite = { ref: "E22", type: "inference", text: "Third-party source reports: Acme is preparing for SOC 2. Acme is preparing for its SOC 2 audit.", url: "https://news.example/x" };
    const r = run("We take security seriously", {}, [t], { preparing_certification: ["E22"] });
    expect(prepStatus(r)).not.toBe("FOUND");
  });
});

describe("audit regressions", () => {
  it.each([
    "We are working towards becoming SOC 2 certified by Q3",
    "We are preparing for our SOC 2 Type II attestation",
    "We are not SOC 2 certified yet",
    "This social platform is preparing for SOC 2",
  ])("planned, not held: %s", (text) => {
    expect(run(text, { cert: true }).flags).not.toContain("ALREADY_CERTIFIED");
  });

  it("the model's claim can't earn points: only the page quote is checked", () => {
    const evidence: EvidenceLite[] = [
      ...base,
      { ref: "E9", type: "observed", text: "Company is preparing for SOC 2 certification. Trusted by 500 teams", quote: "Trusted by 500 teams", url: "https://acme.com/" },
    ];
    const r = decideQualification({
      findings: findings({ ...saasB2B, found: { saas: ["E1"], b2b: ["E2"], preparing_certification: ["E9"] } }),
      evidence,
      checkedPages: ALL,
      pagesScraped: [],
      canResearchMore: false,
    });
    expect(prepStatus(r as never)).not.toBe("FOUND");
  });

  it.each([
    ["SOC 2 report available on the Enterprise plan", "preparing_certification"],
    ["Acme is SOC 2 certified. Start a free trial", "preparing_certification"],
  ])("'%s' is not audit preparation", (text) => {
    expect(prepStatus(run(text, { prep: true }))).not.toBe("FOUND");
  });

  it("'No credit card required' isn't an enterprise security review; SMEs aren't enterprise targeting", () => {
    const r = run("Start free. No credit card required.", {}, [{ ref: "E30", type: "observed", text: "Built for small and medium enterprises", url: "https://acme.com/" }], {
      enterprise_security_reviews: ["E9"],
      targets_enterprise: ["E30"],
    });
    const crit = (id: string) => Object.values(r.categories).flatMap((c) => c.criteria).find((c) => c.id === id)!.status;
    expect(crit("enterprise_security_reviews")).not.toBe("FOUND");
    expect(crit("targets_enterprise")).not.toBe("FOUND");
  });

  it("'trust' or 'risk' outside a job context isn't compliance hiring; a security job is", () => {
    const notJob = run("Trusted by risk-averse banks", {}, [], { compliance_hiring: ["E9"] });
    const job = run("We're hiring a Security & Compliance Engineer", {}, [], { compliance_hiring: ["E9"] });
    const status = (r: ReturnType<typeof run>) => r.categories.compliance_buying_signals.criteria.find((c) => c.id === "compliance_hiring")!.status;
    expect(status(notJob)).not.toBe("FOUND");
    expect(status(job)).toBe("FOUND");
  });

  it("a blog article about HIPAA prep doesn't count as the company's own preparation", () => {
    const r = decideQualification({
      findings: findings({ ...saasB2B, found: { saas: ["E1"], b2b: ["E2"], preparing_certification: ["E9"] } }),
      evidence: [...base, { ref: "E9", type: "observed", text: "x", quote: "How to prepare for HIPAA audits in 2026", url: "https://acme.com/blog/hipaa", pageTag: "blog" }],
      checkedPages: ALL,
      pagesScraped: [],
      canResearchMore: false,
    });
    expect(prepStatus(r as never)).not.toBe("FOUND");
  });
});
