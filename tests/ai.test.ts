import { beforeEach, describe, expect, it } from "vitest";
import { checkEmail, checkPainPoints, quoteAppearsIn, unsupportedNumbers } from "@/lib/pipeline/checks";
import { extractionPrompt } from "@/lib/prompts";
import { runPrompt } from "@/lib/providers/llm";
import { LLMError } from "@/lib/providers/llm/types";
import type { GeneratedEmail } from "@/lib/schemas";
import { ScriptedLLM, freshDb } from "./helpers";

const validProfile = {
  company_name: "Acme",
  description: "Cloud HR software",
  business_model: "SaaS",
  industry: "HR tech",
  is_saas: "yes",
  saas_evidence_ids: ["E1"],
  funding_stage: "Unknown",
  funding_evidence_ids: [],
  company_size: null,
  target_customer: "Unknown",
  enterprise_focus: "unknown",
  enterprise_evidence_ids: [],
  is_compliance_automation_vendor: false,
  audit_signals: [],
  compliance_signals: [],
  security_signals: [],
  customer_signals: [],
  growth_signals: [],
  inferences: [],
  unknowns: ["funding stage"],
  contradictions: [],
  confidence: 0.6,
};

describe("structured model output", () => {
  beforeEach(() => freshDb());

  it("18. parses and validates structured extraction output", async () => {
    const llm = new ScriptedLLM({ extraction: () => JSON.stringify(validProfile) });
    const out = await runPrompt(llm, extractionPrompt, { domain: "acme.com", evidence: [] });
    expect(out.is_saas).toBe("yes");
  });

  it("19. retries on invalid JSON / schema errors, then fails cleanly", async () => {
    const fixes = new ScriptedLLM({ extraction: (_i, n) => (n === 1 ? "not json {" : "```json\n" + JSON.stringify(validProfile) + "\n```") });
    await expect(runPrompt(fixes, extractionPrompt, { domain: "acme.com", evidence: [] })).resolves.toMatchObject({ company_name: "Acme" });
    expect(fixes.calls.extraction).toBe(2);

    const broken = new ScriptedLLM({ extraction: () => ({ ...validProfile, is_saas: "definitely" }) });
    await expect(runPrompt(broken, extractionPrompt, { domain: "acme.com", evidence: [] })).rejects.toBeInstanceOf(LLMError);
    expect(broken.calls.extraction).toBe(2); // 1 + LLM_MAX_JSON_RETRIES (default 1)
  });
});

describe("evidence checks", () => {
  it("verifies quotes verbatim (normalised) against the page", () => {
    const page = "We are currently preparing for our SOC 2 Type II audit — expected in Q1.";
    expect(quoteAppearsIn("preparing for our SOC 2  Type II audit", page)).toBe(true);
    expect(quoteAppearsIn("we are SOC 2 certified already", page)).toBe(false);
  });

  it("flags numbers not present in the evidence", () => {
    expect(unsupportedNumbers("They raised $40M and grew 300%", ["raised $32 million"])).toEqual(["$40M", "300%"]);
    expect(unsupportedNumbers("Preparing for SOC 2 and ISO 27001 in 2026", [])).toEqual([]);
    // whole-token matching: digits inside other numbers don't count as support
    expect(unsupportedNumbers("You raised $20M and cut audit prep by 40%", ["Founded 2024, we now have 140 customers"])).toEqual(["$20M", "40%"]);
    expect(unsupportedNumbers("the $32 million round", ["raised $32M in Series B"])).toEqual([]);
    // units must match too, and "2" is only exempt inside "SOC 2"
    expect(unsupportedNumbers("They raised $40M", ["We have 40 employees"])).toEqual(["$40M"]);
    expect(unsupportedNumbers("2x faster and a $2M round", ["We are SOC 2 certified"])).toEqual(["2x", "$2M"]);
    expect(unsupportedNumbers("Your 40 engineers", ["40 engineers work here"])).toEqual([]);
  });
});

const known = new Map([
  ["E1", { type: "observed", text: "We are preparing for our SOC 2 audit" }],
  ["E2", { type: "inference", text: "Appears to be growing" }],
]);

describe("pain points", () => {
  it("20. requires exactly two pain points", () => {
    const one = checkPainPoints({ insufficient_evidence: false, pain_points: [{ statement: "A", why_it_matters_to_this_person: "x", evidence_ids: ["E1"], type: "direct", confidence: 0.7 }] }, known);
    expect(one.ok).toBe(false);
    expect(one.problems.join()).toMatch(/exactly 2/);
  });

  it("21. pain points must be evidence-backed; 'direct' needs observed evidence", () => {
    const r = checkPainPoints(
      {
        insufficient_evidence: false,
        pain_points: [
          { statement: "SOC 2 prep consumes engineering time", why_it_matters_to_this_person: "CTO", evidence_ids: ["E1"], type: "direct", confidence: 0.8 },
          { statement: "Growth adds compliance scope", why_it_matters_to_this_person: "CTO", evidence_ids: ["E2"], type: "direct", confidence: 80 },
        ],
      },
      known,
    );
    expect(r.ok).toBe(true);
    expect(r.painPoints[1].type).toBe("inferred");
    expect(r.painPoints[1].confidence).toBe(0.8);
    const unsupported = checkPainPoints(
      { insufficient_evidence: false, pain_points: [{ statement: "Lost $2M in deals", why_it_matters_to_this_person: "x", evidence_ids: ["E9"], type: "direct", confidence: 1 }, { statement: "B", why_it_matters_to_this_person: "x", evidence_ids: ["E1"], type: "direct", confidence: 1 }] },
      known,
    );
    expect(unsupported.ok).toBe(false);
  });
});

function email(over: Partial<GeneratedEmail> = {}): GeneratedEmail {
  return {
    subject: "Acme's SOC 2 preparation",
    body: "Hi Jane,\n\nI noticed on Acme's security page that the team is preparing for a SOC 2 audit. Preparing for SOC 2 often means collecting evidence and maintaining controls by hand, which can pull engineers away from product work. Given your role as CTO, I thought this might be relevant.\n\nSprinto helps SaaS companies automate evidence collection and control monitoring for SOC 2, ISO 27001 and GDPR, so audits take far less manual effort.\n\nWould a short call next week be useful?\n\nBest,\nSprinto Growth Team",
    prospect_name: "Jane Doe",
    prospect_role: "CTO",
    personalisation_hook: "preparing for SOC 2",
    pain_point_used: "SOC 2 prep",
    evidence_ids: ["E1"],
    personalisation_explanation: "",
    ...over,
  };
}
const ctx = {
  companyName: "Acme",
  domain: "acme.com",
  contactFullName: "Jane Doe",
  contactFirstName: "Jane",
  contactTitle: "CTO",
  prospectEmail: "jane@acme.com",
  knownEvidence: known,
  auditLevel: "active_or_planned",
  enterpriseLevel: "none",
  otherCompanyNames: ["Globex"],
};

describe("email validation (deterministic)", () => {
  beforeEach(() => freshDb());

  it("22/25/26. a well-personalised email passes; it greets the prospect and names the company", () => {
    const r = checkEmail(email(), ctx);
    expect(r.issues).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("23. catches wrong name, wrong company, banned phrases, missing CTA and unsupported claims", () => {
    expect(checkEmail(email({ body: email().body.replace("Hi Jane", "Hi John") }), ctx).issues.join()).toMatch(/greets_prospect_by_name/);
    expect(checkEmail(email({ body: email().body.replace(/Acme/g, "Globex") }), ctx).issues.join()).toMatch(/company_name_present|no_other_company_names/);
    expect(checkEmail(email({ body: email().body.replace("I noticed", "I hope this email finds you well. I noticed") }), ctx).issues.join()).toMatch(/banned/);
    expect(checkEmail(email({ body: email().body.replace("Would a short call next week be useful?", "Thanks.") }), ctx).issues.join()).toMatch(/clear_cta/);
    expect(checkEmail(email({ body: email().body.replace("SOC 2 audit.", "SOC 2 audit after losing $3M in deals.") }), ctx).issues.join()).toMatch(/unsupported_numbers/);
    expect(checkEmail(email(), { ...ctx, auditLevel: "generic_material" }).issues.join()).toMatch(/prep_claim_supported/);
    expect(checkEmail(email({ evidence_ids: ["E404"] }), ctx).issues.join()).toMatch(/evidence_cited/);
    expect(checkEmail(email({ body: email().body + " jane@acme.com" }), ctx).issues.join()).toMatch(/no_prospect_email_in_body/);
    expect(checkEmail(email({ body: email().body + " Write to security@acme.com." }), ctx).issues.join()).toMatch(/no_email_addresses/);
    expect(checkEmail(email({ subject: "Acme raised $90M" }), ctx).issues.join()).toMatch(/unsupported_numbers/);
  });

  it("enforces length bounds", () => {
    expect(checkEmail(email({ body: "Hi Jane,\nAcme. Sprinto? Call?" }), ctx).issues.join()).toMatch(/length_ok/);
  });
});
