/**
 * Deterministic ICP qualification. The model only classifies signals; this
 * module (1) downgrades any classification that is not backed by the right kind
 * of evidence, (2) computes the 0–100 score from the configured rubric, and
 * (3) applies the qualification gates. A high score never overrides the gates.
 */
import { ALLOW_LIKELY_SAAS_TO_QUALIFY, QUALIFYING_TRIGGERS, SCORING_RUBRIC } from "@/lib/config";
import type {
  AuditLevel,
  EnterpriseLevel,
  QualificationClassification,
  QualificationResult,
  SaasLevel,
  StageLevel,
} from "@/lib/schemas";

export interface EvidenceLite {
  ref: string;
  type: "observed" | "inference" | "unknown";
  text: string; // claim + quote
}

/** Text patterns a direct-level classification's evidence must actually contain. */
const DIRECT_PATTERNS = {
  saasConfirmed: /saas|software|subscription|cloud|platform|per (seat|user)|app\b/i,
  seriesAC: /series\s*[abc]\b/i,
  otherStage: /seed|series\s*[d-z]\b|ipo|public(ly)? (listed|traded)|nasdaq|nyse|bootstrap|self-funded/i,
  audit: /soc\s*-?\s*2|iso\s*-?\s*27001|gdpr|hipaa|pci|audit|certif|attest/i,
  enterprisePressure: /soc|iso|certif|security review|questionnaire|procurement|vendor (security|assessment|risk)|compliance|due diligence/i,
};

function checkEvidence(ids: string[], ev: Map<string, EvidenceLite>, pattern?: RegExp) {
  const valid = ids.filter((id) => ev.has(id));
  const observed = valid.filter((id) => ev.get(id)!.type === "observed");
  const observedMatching = pattern ? observed.filter((id) => pattern.test(ev.get(id)!.text)) : observed;
  return { valid, observed, observedMatching };
}

export interface EnforcedClassification {
  saas: SaasLevel;
  stage: StageLevel;
  stageLabel: string;
  audit: AuditLevel;
  enterprise: EnterpriseLevel;
  outsideTarget: { flag: boolean; reason: string };
  evidence: { saas: string[]; stage: string[]; audit: string[]; enterprise: string[] };
  adjustments: string[];
}

/** Weak evidence is never treated as direct evidence. */
export function enforceEvidence(c: QualificationClassification, evidence: EvidenceLite[]): EnforcedClassification {
  const ev = new Map(evidence.map((e) => [e.ref, e]));
  const adjustments: string[] = [];
  const note = (dim: string, from: string, to: string, why: string) => adjustments.push(`${dim}: ${from} → ${to} (${why})`);

  // SaaS
  let saas = c.saas.level;
  const se = checkEvidence(c.saas.evidence_ids, ev, DIRECT_PATTERNS.saasConfirmed);
  if (saas === "confirmed" && se.observedMatching.length === 0) {
    const to: SaasLevel = se.valid.length ? "likely" : "unknown";
    note("SaaS", saas, to, "no observed evidence describing a software product");
    saas = to;
  } else if (saas === "likely" && se.valid.length === 0) {
    note("SaaS", saas, "unknown", "no cited evidence");
    saas = "unknown";
  } else if (saas === "not_saas" && se.observed.length === 0) {
    note("SaaS", saas, "unknown", "rejection requires observed evidence");
    saas = "unknown";
  }

  // Stage
  let stage = c.stage.level;
  let stageLabel = c.stage.stage_label || "Unknown";
  const st = checkEvidence(c.stage.evidence_ids, ev, stage === "series_a_c" ? DIRECT_PATTERNS.seriesAC : DIRECT_PATTERNS.otherStage);
  if ((stage === "series_a_c" || stage === "other_verified") && st.observedMatching.length === 0) {
    const to: StageLevel = st.valid.length ? "growth_indicators" : "unknown";
    note("Stage", stage, to, "no observed evidence naming the funding stage");
    stage = to;
    stageLabel = "Unknown";
  } else if (stage === "growth_indicators" && st.valid.length === 0) {
    note("Stage", stage, "unknown", "no cited evidence");
    stage = "unknown";
  }

  // Audit / compliance intent
  let audit = c.audit.level;
  const au = checkEvidence(c.audit.evidence_ids, ev, DIRECT_PATTERNS.audit);
  if (["active_or_planned", "initiative_timing_uncertain", "already_certified"].includes(audit) && au.observedMatching.length === 0) {
    const to: AuditLevel = au.valid.length ? "generic_material" : "none";
    note("Audit", audit, to, "no observed evidence mentioning an audit or certification");
    audit = to;
  } else if (audit === "generic_material" && au.valid.length === 0) {
    note("Audit", audit, "none", "no cited evidence");
    audit = "none";
  }

  // Enterprise pressure
  let enterprise = c.enterprise.level;
  const en = checkEvidence(c.enterprise.evidence_ids, ev, DIRECT_PATTERNS.enterprisePressure);
  if ((enterprise === "direct_requirement" || enterprise === "security_reviews") && en.observedMatching.length === 0) {
    const to: EnterpriseLevel = en.valid.length ? "enterprise_positioning" : "none";
    note("Enterprise", enterprise, to, "no observed evidence of certification/security-review pressure");
    enterprise = to;
  } else if (enterprise === "enterprise_positioning" && en.valid.length === 0) {
    note("Enterprise", enterprise, "none", "no cited evidence");
    enterprise = "none";
  }

  const ot = checkEvidence(c.outside_target.evidence_ids, ev);
  const outsideTarget = { flag: c.outside_target.flag && ot.observed.length > 0, reason: c.outside_target.reason };
  if (c.outside_target.flag && !outsideTarget.flag) adjustments.push("Outside-target flag ignored (no observed evidence)");

  return {
    saas,
    stage,
    stageLabel,
    audit,
    enterprise,
    outsideTarget,
    evidence: { saas: se.valid, stage: st.valid, audit: au.valid, enterprise: en.valid },
    adjustments,
  };
}

export function computeScore(e: Pick<EnforcedClassification, "saas" | "stage" | "audit" | "enterprise">) {
  const breakdown = {
    saas: SCORING_RUBRIC.saas[e.saas],
    stage: SCORING_RUBRIC.stage[e.stage],
    audit: SCORING_RUBRIC.audit[e.audit],
    enterprise: SCORING_RUBRIC.enterprise[e.enterprise],
  };
  return { total: breakdown.saas + breakdown.stage + breakdown.audit + breakdown.enterprise, breakdown };
}

const LABEL = {
  saas: { confirmed: "Confirmed SaaS", likely: "Likely SaaS", not_saas: "Not SaaS", unknown: "SaaS status unknown" },
  stage: { series_a_c: "Verified Series A–C", growth_indicators: "Growing, stage unknown", other_verified: "Other verified stage", unknown: "Stage unknown" },
  audit: {
    active_or_planned: "Preparing for an audit",
    initiative_timing_uncertain: "Compliance work underway, no date",
    already_certified: "Already certified (renewal & expansion)",
    generic_material: "Generic security wording only",
    none: "No audit evidence",
  },
  enterprise: {
    direct_requirement: "Customers require certification",
    security_reviews: "Facing security reviews",
    enterprise_positioning: "Enterprise focus, no pressure shown",
    none: "No enterprise pressure",
  },
} as const;
export const LEVEL_LABELS = LABEL;

export function decideQualification(params: {
  classification: QualificationClassification;
  evidence: EvidenceLite[];
  canResearchMore: boolean;
  noUsableEvidence?: boolean;
}): QualificationResult {
  const e = enforceEvidence(params.classification, params.evidence);
  const { total, breakdown } = computeScore(e);
  const auditTrigger = (QUALIFYING_TRIGGERS.audit as readonly string[]).includes(e.audit);
  const entTrigger = (QUALIFYING_TRIGGERS.enterprise as readonly string[]).includes(e.enterprise);
  const hasTrigger = auditTrigger || entTrigger;
  const reasons: string[] = [
    LABEL.saas[e.saas],
    LABEL.stage[e.stage] + (e.stage === "series_a_c" || e.stage === "other_verified" ? ` (${e.stageLabel})` : ""),
    LABEL.audit[e.audit],
    LABEL.enterprise[e.enterprise],
  ];
  const missing = params.classification.missing_information.map((m) => `${m.dimension}: ${m.question}`);
  const saasOk = e.saas === "confirmed" || (ALLOW_LIKELY_SAAS_TO_QUALIFY && e.saas === "likely");

  let decision: QualificationResult["decision"];
  let explanation: string;
  if (params.noUsableEvidence) {
    decision = "needs_review";
    explanation = "No usable public information found.";
  } else if (e.outsideTarget.flag) {
    decision = "not_qualified";
    explanation = `Outside target: ${e.outsideTarget.reason || "see evidence"}.`;
  } else if (e.saas === "not_saas") {
    decision = "not_qualified";
    explanation = "Not a SaaS business.";
  } else if (saasOk && hasTrigger) {
    decision = "qualified";
    const trig = [auditTrigger ? LABEL.audit[e.audit].toLowerCase() : null, entTrigger ? LABEL.enterprise[e.enterprise].toLowerCase() : null]
      .filter(Boolean)
      .join(" and ");
    explanation = `SaaS company ${trig}.`;
  } else if (params.canResearchMore && (e.saas === "unknown" || !hasTrigger || (e.saas === "likely" && hasTrigger))) {
    decision = "research_more";
    explanation = "Key facts missing — researching further.";
  } else if (e.saas === "likely" && hasTrigger) {
    decision = "needs_review";
    explanation = "Has a buying trigger, but SaaS model unconfirmed.";
  } else if (e.saas === "unknown") {
    decision = "needs_review";
    explanation = "Couldn't confirm it sells SaaS.";
  } else {
    decision = "needs_review";
    explanation = "SaaS, but no audit or enterprise trigger found.";
  }

  const evidenceIds = [...new Set([...e.evidence.saas, ...e.evidence.stage, ...e.evidence.audit, ...e.evidence.enterprise])];
  const observedCount = evidenceIds.filter((id) => params.evidence.find((x) => x.ref === id)?.type === "observed").length;
  const knownDims = [e.saas !== "unknown", e.stage !== "unknown", e.audit !== "none", e.enterprise !== "none"].filter(Boolean).length;
  const confidence = Math.round(Math.min(1, 0.25 + 0.12 * knownDims + 0.05 * Math.min(observedCount, 6) - 0.05 * e.adjustments.length) * 100) / 100;

  return {
    decision,
    fit_score: total,
    score_breakdown: breakdown,
    saas_status: e.saas,
    stage_status: e.stage,
    stage_label: e.stageLabel,
    audit_trigger: e.audit,
    enterprise_pressure: e.enterprise,
    has_buying_trigger: hasTrigger,
    reasons,
    evidence_ids: evidenceIds,
    missing_information: missing,
    adjustments: e.adjustments,
    confidence: Math.max(0, confidence),
    explanation,
  };
}

/** When the research budget is spent without resolving the gaps, convert research_more into an honest needs_review. */
export function finalizeUnresolved(r: QualificationResult, roundsRun: number): QualificationResult {
  if (r.decision !== "research_more") return r;
  const after = roundsRun ? ` after ${roundsRun} extra research round${roundsRun > 1 ? "s" : ""}` : "";
  let explanation: string;
  if (r.saas_status === "unknown") explanation = `Couldn't confirm it sells SaaS${after}.`;
  else if (r.saas_status === "likely" && r.has_buying_trigger)
    explanation = `Has a buying trigger, but SaaS model unconfirmed${after}.`;
  else
    explanation = `SaaS, but no audit or enterprise trigger found${after}.`;
  return { ...r, decision: "needs_review", explanation };
}

/** Gaps worth another research round (dimensions not yet resolved). */
export function researchableGaps(r: QualificationResult): { dimension: string; question: string }[] {
  const gaps: { dimension: string; question: string }[] = [];
  if (r.saas_status === "unknown" || r.saas_status === "likely") gaps.push({ dimension: "saas", question: "Is the core product sold as cloud/subscription software?" });
  if (!(QUALIFYING_TRIGGERS.audit as readonly string[]).includes(r.audit_trigger))
    gaps.push({ dimension: "audit", question: "Is the company preparing for or planning SOC 2 / ISO 27001 / other audits?" });
  if (!(QUALIFYING_TRIGGERS.enterprise as readonly string[]).includes(r.enterprise_pressure))
    gaps.push({ dimension: "enterprise", question: "Do enterprise customers or procurement require certification or security reviews?" });
  if (r.stage_status === "unknown") gaps.push({ dimension: "stage", question: "What funding stage is the company at?" });
  return gaps;
}
