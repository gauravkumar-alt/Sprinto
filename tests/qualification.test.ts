import { describe, expect, it } from "vitest";
import { computeScore, decideQualification, enforceEvidence, type EvidenceLite } from "@/lib/pipeline/qualification";
import { classification } from "./helpers";

const ev: EvidenceLite[] = [
  { ref: "E1", type: "observed", text: "Acme is a cloud-based SaaS platform billed per seat" },
  { ref: "E2", type: "observed", text: "Acme raised a $20M Series B" },
  { ref: "E3", type: "observed", text: "We are preparing for our SOC 2 Type II audit" },
  { ref: "E4", type: "observed", text: "Enterprise customers require ISO 27001 certification before signing" },
  { ref: "E5", type: "observed", text: "Trusted by Fortune 500 enterprises" },
  { ref: "E6", type: "inference", text: "The company appears to prepare for SOC 2 audit" },
  { ref: "E7", type: "observed", text: "We are an IT consulting and staffing firm" },
  { ref: "E8", type: "observed", text: "We take security seriously" },
];
const saas = { level: "confirmed" as const, evidence_ids: ["E1"], rationale: "" };

describe("ICP qualification engine", () => {
  it("1. recognises a confirmed SaaS company", () => {
    const r = decideQualification({ classification: classification({ saas, audit: { level: "active_or_planned", evidence_ids: ["E3"], rationale: "" } }), evidence: ev, canResearchMore: false });
    expect(r.saas_status).toBe("confirmed");
    expect(r.decision).toBe("qualified");
  });

  it("2. rejects a non-SaaS business with observed evidence", () => {
    const r = decideQualification({ classification: classification({ saas: { level: "not_saas", evidence_ids: ["E7"], rationale: "" } }), evidence: ev, canResearchMore: true });
    expect(r.decision).toBe("not_qualified");
  });

  it("2b. does not reject as non-SaaS without observed evidence", () => {
    const r = decideQualification({ classification: classification({ saas: { level: "not_saas", evidence_ids: [], rationale: "" } }), evidence: ev, canResearchMore: false });
    expect(r.decision).toBe("needs_review");
    expect(r.saas_status).toBe("unknown");
  });

  it("3. awards stage points for a verified Series A–C round", () => {
    const r = decideQualification({
      classification: classification({ saas, stage: { level: "series_a_c", evidence_ids: ["E2"], rationale: "", stage_label: "Series B" }, audit: { level: "active_or_planned", evidence_ids: ["E3"], rationale: "" } }),
      evidence: ev,
      canResearchMore: false,
    });
    expect(r.score_breakdown.stage).toBe(15);
    expect(r.stage_label).toBe("Series B");
  });

  it("3b. a stage claim whose evidence does not name the round is downgraded", () => {
    const e = enforceEvidence(classification({ stage: { level: "series_a_c", evidence_ids: ["E5"], rationale: "", stage_label: "Series B" } }), ev);
    expect(e.stage).toBe("growth_indicators");
  });

  it("4. unknown funding stage does not block qualification", () => {
    const r = decideQualification({ classification: classification({ saas, enterprise: { level: "direct_requirement", evidence_ids: ["E4"], rationale: "" } }), evidence: ev, canResearchMore: false });
    expect(r.stage_status).toBe("unknown");
    expect(r.decision).toBe("qualified");
  });

  it("5. qualifies on an audit trigger alone", () => {
    const r = decideQualification({ classification: classification({ saas, audit: { level: "active_or_planned", evidence_ids: ["E3"], rationale: "" } }), evidence: ev, canResearchMore: false });
    expect(r.decision).toBe("qualified");
    expect(r.enterprise_pressure).toBe("none");
  });

  it("6. qualifies on enterprise pressure alone", () => {
    const r = decideQualification({ classification: classification({ saas, enterprise: { level: "security_reviews", evidence_ids: ["E4"], rationale: "" } }), evidence: ev, canResearchMore: false });
    expect(r.decision).toBe("qualified");
  });

  it("7. uses OR logic between the two triggers", () => {
    const both = decideQualification({
      classification: classification({ saas, audit: { level: "active_or_planned", evidence_ids: ["E3"], rationale: "" }, enterprise: { level: "direct_requirement", evidence_ids: ["E4"], rationale: "" } }),
      evidence: ev,
      canResearchMore: false,
    });
    const neither = decideQualification({ classification: classification({ saas }), evidence: ev, canResearchMore: false });
    expect(both.decision).toBe("qualified");
    expect(neither.decision).toBe("needs_review");
  });

  it("8. weak evidence is not treated as direct evidence", () => {
    // inference-only evidence for an "active" audit, logos-only for "direct requirement"
    const r = decideQualification({
      classification: classification({ saas, audit: { level: "active_or_planned", evidence_ids: ["E6"], rationale: "" }, enterprise: { level: "direct_requirement", evidence_ids: ["E5"], rationale: "" } }),
      evidence: ev,
      canResearchMore: false,
    });
    expect(r.audit_trigger).toBe("generic_material");
    expect(r.enterprise_pressure).toBe("enterprise_positioning");
    expect(r.decision).toBe("needs_review");
    expect(r.adjustments.length).toBe(2);
  });

  it("8b. evidence ids that don't exist are ignored", () => {
    const e = enforceEvidence(classification({ saas: { level: "confirmed", evidence_ids: ["E999"], rationale: "" } }), ev);
    expect(e.saas).toBe("unknown");
  });

  it("9. SaaS without a buying trigger → needs review (high score does not override the gate)", () => {
    const r = decideQualification({
      classification: classification({
        saas,
        stage: { level: "series_a_c", evidence_ids: ["E2"], rationale: "", stage_label: "Series B" },
        audit: { level: "generic_material", evidence_ids: ["E8"], rationale: "" },
        enterprise: { level: "enterprise_positioning", evidence_ids: ["E5"], rationale: "" },
      }),
      evidence: ev,
      canResearchMore: false,
    });
    expect(r.fit_score).toBe(55);
    expect(r.decision).toBe("needs_review");
  });

  it("9b. returns research_more when gaps remain and budget allows", () => {
    const r = decideQualification({ classification: classification({ saas }), evidence: ev, canResearchMore: true });
    expect(r.decision).toBe("research_more");
  });

  it("10. scoring is deterministic and follows the rubric", () => {
    const s = { saas: "confirmed", stage: "series_a_c", audit: "active_or_planned", enterprise: "direct_requirement" } as const;
    expect(computeScore(s).total).toBe(100);
    expect(computeScore({ saas: "likely", stage: "growth_indicators", audit: "initiative_timing_uncertain", enterprise: "security_reviews" }).total).toBe(15 + 8 + 20 + 20);
    const a = decideQualification({ classification: classification({ saas }), evidence: ev, canResearchMore: false });
    const b = decideQualification({ classification: classification({ saas }), evidence: ev, canResearchMore: false });
    expect(a).toEqual(b);
  });

  it("likely SaaS with a trigger needs review rather than qualifying", () => {
    const r = decideQualification({
      classification: classification({ saas: { level: "likely", evidence_ids: ["E6"], rationale: "" }, audit: { level: "active_or_planned", evidence_ids: ["E3"], rationale: "" } }),
      evidence: ev,
      canResearchMore: false,
    });
    expect(r.decision).toBe("needs_review");
  });

  it("competitors (outside target) are not qualified", () => {
    const r = decideQualification({
      classification: classification({ saas, audit: { level: "active_or_planned", evidence_ids: ["E3"], rationale: "" }, outside_target: { flag: true, reason: "compliance automation vendor", evidence_ids: ["E1"] } }),
      evidence: ev,
      canResearchMore: false,
    });
    expect(r.decision).toBe("not_qualified");
  });
});
