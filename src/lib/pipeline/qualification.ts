/**
 * Deterministic qualification engine (100-point rubric, Sprinto Evidence Map).
 *
 * The model only reports per-criterion FINDINGS with evidence ids. This module:
 *  1. validates every finding against the actual evidence (observed quote + criterion pattern),
 *  2. marks each criterion FOUND / NOT_FOUND (a relevant page was checked) / UNKNOWN (none could be),
 *  3. applies the disqualification rules (they take priority over the score),
 *  4. computes the score and applies the configurable thresholds.
 * A high score never overrides a disqualification or a missing SaaS / B2B requirement.
 */
import { ALREADY_CERTIFIED_QUALIFIES, CRITERIA, OPEN_ROLES_THRESHOLD, RUBRIC, getThresholds, type CriterionId, type RubricCategory } from "@/lib/config";
import type { AuditLevel, CategoryResult, CriterionResult, CriterionStatus, EnterpriseLevel, QualificationFindings, QualificationResult, SaasLevel, StageLevel } from "@/lib/schemas";

export interface EvidenceLite {
  ref: string;
  type: "observed" | "inference" | "unknown";
  text: string; // claim + quote
  url?: string | null;
  pageTag?: string | null; // page type the evidence came from (homepage, hiring, security/compliance, …)
}

// "SOC 2", "SOC2", "SOC-2", "SOC II", "SOC two"; ISO 27001/27701; HIPAA; PCI DSS; FedRAMP; HITRUST.
const CERT_RE = /soc\s*-?\s*(2|ii|two)\b|iso\s*-?\s*2700[1-9]|hipaa|pci[\s-]*dss|fedramp|hitrust/i;
const PREP_RE = /prepar|pursu|plan(s|ned|ning)?\b|working (to|towards?)|in progress|pending|underway|road\s*map|expect|upcoming|coming soon|in the process|on track|kick(ed)? off|begin|start(ed|ing)? (our|the|a)/i;
const HELD_RE = /certified|compliant|attest|report (is )?available|audited|achieved|holds?\b|maintains?|passed|completed|successfully|is soc|are soc|type (ii|2) report/i;

/** Text each criterion's supporting quote must contain to count as direct evidence. */
const PATTERNS: Partial<Record<CriterionId, RegExp[]>> = {
  // SaaS delivery: the word itself, a hosted product, or self-serve subscription plans ("free plan", "no credit card", "/month").
  saas: [/saas|software|subscription|cloud|platform|\bapp\b|per (seat|user|month)|\bapi\b|\b(free|pro|team|business|enterprise|starter|growth) (plan|tier)|free trial|no credit card|sign up (for )?free|\/\s?mo(nth)?\b|hosted/i],
  funding_series_ac: [/series\s*-?\s*[abc]\b/i],
  enterprise_pricing: [/enterprise/i],
  preparing_certification: [CERT_RE, PREP_RE],
  compliance_hiring: [/security|compliance|\bgrc\b|risk|infosec|privacy|trust/i],
  enterprise_security_reviews: [/questionnaire|security review|procurement|vendor (security|risk|assessment)|due diligence|requir|\bdpa\b|security (package|portal)|trust (center|centre|portal)/i],
  targets_enterprise: [/enterprise|large (organi[sz]ations|companies|businesses|teams)|fortune\s*\d+|global brands/i],
};

/** The five critical research questions and the page types that answer them (targeted, never random). */
export const CRITICAL_QUESTIONS = [
  { key: "business_model", question: "Is this a B2B SaaS company?", criteria: ["saas", "b2b"] as CriterionId[], pages: ["product", "about"] },
  { key: "offering", question: "What does it sell?", criteria: ["product"] as CriterionId[], pages: ["product"] },
  { key: "growth", question: "What is its growth stage?", criteria: ["funding_series_ac", "open_roles"] as CriterionId[], pages: ["hiring", "funding/news", "about"] },
  { key: "compliance", question: "Is there evidence of compliance pressure?", criteria: ["preparing_certification", "compliance_hiring", "enterprise_security_reviews"] as CriterionId[], pages: ["security/compliance", "hiring"] },
  { key: "certified", question: "Is it already certified?", criteria: [] as CriterionId[], pages: ["security/compliance"] },
] as const;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n > 1 ? n / 100 : n));

export function decideQualification(params: {
  findings: QualificationFindings;
  evidence: EvidenceLite[];
  /** Page types that were fetched or attempted (a missing page counts as checked). */
  checkedPages: Set<string>;
  pagesScraped: string[];
  canResearchMore: boolean;
}): QualificationResult {
  const { findings, evidence, checkedPages } = params;
  const byRef = new Map(evidence.map((e) => [e.ref, e]));
  const adjustments: string[] = [];
  const observed = (ids: string[]) => ids.filter((id) => byRef.get(id)?.type === "observed");
  const findingFor = (id: CriterionId) => findings.criteria.find((c) => c.id === id);

  // ── 1. criteria: validate each finding against its evidence ──
  const results: Record<string, CriterionResult> = {};
  for (const def of CRITERIA) {
    const f = findingFor(def.id);
    const valid = observed(f?.evidence_ids ?? []);
    const matching = valid.filter((ref) => (PATTERNS[def.id] ?? []).every((re) => re.test(byRef.get(ref)!.text)));
    let found = Boolean(f?.found) && matching.length > 0;

    if (def.id === "open_roles" && found) {
      const count = findings.open_roles_count ?? 0;
      if (count < OPEN_ROLES_THRESHOLD) {
        found = false;
        adjustments.push(`Open roles: ${count} found (< ${OPEN_ROLES_THRESHOLD})`);
      }
    }
    if (def.id === "saas" && findings.is_saas !== "yes") found = false;
    if (def.id === "b2b" && !["b2b", "both"].includes(findings.audience)) found = false;
    if (f?.found && !found && def.id !== "open_roles") adjustments.push(`${def.label}: claimed, but no supporting quote — not counted`);

    const checked = def.pages.some((p) => checkedPages.has(p));
    const status: CriterionStatus = found ? "FOUND" : checked ? "NOT_FOUND" : "UNKNOWN";
    const refs = found ? matching : [];
    results[def.id] = {
      id: def.id,
      criterion: def.label,
      max_points: def.points,
      points: found ? def.points : 0,
      status,
      evidence: refs.map((ref) => ({ ref, text: byRef.get(ref)!.text, source_url: byRef.get(ref)!.url ?? null })),
      confidence: found ? clamp01(f?.confidence ?? 0.7) : 0,
      note: f?.note ?? "",
    };
  }

  const categories = Object.fromEntries(
    (Object.keys(RUBRIC) as RubricCategory[]).map((cat) => {
      const crit = CRITERIA.filter((c) => c.category === cat).map((c) => results[c.id]);
      const cr: CategoryResult = { label: RUBRIC[cat].label, score: crit.reduce((a, c) => a + c.points, 0), max: crit.reduce((a, c) => a + c.max_points, 0), criteria: crit };
      return [cat, cr];
    }),
  ) as QualificationResult["categories"];
  const total = Object.values(categories).reduce((a, c) => a + c.score, 0);

  // ── 2. existing certifications (held, not merely planned) ──
  const certs = findings.existing_certifications
    .map((c) => ({
      name: c.name,
      evidence_refs: observed(c.evidence_ids).filter((ref) => {
        const t = byRef.get(ref)!.text;
        return CERT_RE.test(t) && HELD_RE.test(t);
      }),
    }))
    .filter((c) => c.evidence_refs.length > 0);
  if (findings.existing_certifications.length && !certs.length) adjustments.push("Certification claimed, but no quote shows it is already held — ignored");

  // ── 3. disqualification rules (take priority over the score) ──
  const flags: string[] = [];
  const dq: string[] = [];
  const saasEvidence = observed(findingFor("saas")?.evidence_ids ?? []);
  const b2bEvidence = observed(findingFor("b2b")?.evidence_ids ?? []);
  if (findings.is_saas === "no" && saasEvidence.length) dq.push("Not a SaaS business");
  if (findings.audience === "b2c" && b2bEvidence.length) dq.push("Primarily B2C — no B2B product");
  if (findings.outside_target.flag && observed(findings.outside_target.evidence_ids).length) dq.push(`Outside target: ${findings.outside_target.reason || "see evidence"}`);
  if (certs.length) {
    flags.push("ALREADY_CERTIFIED");
    if (!ALREADY_CERTIFIED_QUALIFIES) dq.push(`Already certified (${certs.map((c) => c.name).join(", ")})`);
  }

  // ── 4. decision ──
  const t = getThresholds();
  const saasFound = results.saas.status === "FOUND";
  const b2bFound = results.b2b.status === "FOUND";
  const unknownPotential = CRITERIA.filter((c) => results[c.id].status === "UNKNOWN").reduce((a, c) => a + c.points, 0);
  const missing = missingQuestions(results, checkedPages);
  const certificationChecked = checkedPages.has("security/compliance");

  let decision: QualificationResult["decision"];
  let explanation: string;
  if (dq.length) {
    decision = "not_qualified";
    explanation = `${dq.join(". ")}.`;
  } else if (!saasFound || !b2bFound) {
    decision = params.canResearchMore ? "research_more" : "needs_review";
    explanation = !saasFound && !b2bFound ? "Business model unclear — couldn't confirm B2B SaaS." : !saasFound ? "Couldn't confirm it sells SaaS." : "Couldn't confirm it sells to businesses.";
  } else if (total >= t.qualified && (certificationChecked || !params.canResearchMore)) {
    decision = "qualified";
    explanation = `Qualified at ${total}/100: ${topSignals(results)}.`;
  } else if (total >= t.qualified) {
    decision = "research_more";
    explanation = "Strong score — checking certification status first.";
  } else if (total >= t.needsReview) {
    decision = params.canResearchMore && missing.length ? "research_more" : "needs_review";
    explanation = `Borderline score ${total}/100${missing.length ? ` — unanswered: ${missing.join("; ")}` : ""}.`;
  } else if (params.canResearchMore && total + unknownPotential >= t.needsReview) {
    decision = "research_more";
    explanation = `Score ${total}/100 so far; unchecked criteria could change it.`;
  } else if (missing.some((m) => /compliance|certified/i.test(m)) && total + unknownPotential >= t.needsReview) {
    decision = "needs_review";
    explanation = `Score ${total}/100, but compliance evidence couldn't be checked.`;
  } else {
    decision = "not_qualified";
    explanation = `Score ${total}/100 — below ${t.needsReview}. ${weakestCategory(categories)}.`;
  }

  const foundCount = CRITERIA.filter((c) => results[c.id].status === "FOUND").length;
  const knownCount = CRITERIA.filter((c) => results[c.id].status !== "UNKNOWN").length;
  const confidence = Math.round(Math.min(1, 0.3 + 0.5 * (knownCount / CRITERIA.length) + 0.03 * foundCount - 0.03 * adjustments.length) * 100) / 100;

  // ── 5. summary signals for downstream steps (contact ranking, pain points, emails) ──
  const saas_status: SaasLevel = saasFound ? "confirmed" : dq.includes("Not a SaaS business") ? "not_saas" : "unknown";
  const stage_status: StageLevel = results.funding_series_ac.status === "FOUND" ? "series_a_c" : "unknown";
  const audit_trigger: AuditLevel =
    results.preparing_certification.status === "FOUND" ? "active_or_planned" : certs.length ? "already_certified" : results.compliance_hiring.status === "FOUND" ? "initiative_timing_uncertain" : "none";
  const enterprise_pressure: EnterpriseLevel =
    results.enterprise_security_reviews.status === "FOUND" ? "security_reviews" : results.targets_enterprise.status === "FOUND" ? "enterprise_positioning" : "none";

  const evidenceIds = [...new Set(Object.values(results).flatMap((r) => r.evidence.map((e) => e.ref)).concat(certs.flatMap((c) => c.evidence_refs)))];
  const checkedList = [...checkedPages];

  return {
    decision,
    fit_score: total,
    categories,
    existing_certifications: certs,
    flags,
    disqualification_reasons: dq,
    missing_information: missing,
    pages_scraped: params.pagesScraped,
    company_name: findings.company_name,
    business_description: findings.business_description,
    research_summary: `Read ${params.pagesScraped.length} page${params.pagesScraped.length === 1 ? "" : "s"}; checked ${checkedList.join(", ") || "nothing"}. ${foundCount} of ${CRITERIA.length} criteria found, ${CRITERIA.length - knownCount} unknown.`,
    recommended_next_action: nextAction(decision, dq, missing),
    saas_status,
    stage_status,
    stage_label: results.funding_series_ac.status === "FOUND" ? findings.funding_stage || "Series A–C" : findings.funding_stage || "Unknown",
    audit_trigger,
    enterprise_pressure,
    has_buying_trigger: categories.compliance_buying_signals.score > 0,
    reasons: (Object.values(categories) as CategoryResult[]).map((c) => `${c.label}: ${c.score}/${c.max}`),
    evidence_ids: evidenceIds,
    adjustments,
    confidence: Math.max(0, confidence),
    explanation,
  };
}

function topSignals(r: Record<string, CriterionResult>): string {
  const order: CriterionId[] = ["preparing_certification", "compliance_hiring", "enterprise_security_reviews", "funding_series_ac", "targets_enterprise"];
  const hits = order.filter((id) => r[id].status === "FOUND").map((id) => r[id].criterion.toLowerCase());
  return hits.slice(0, 2).join(", ") || "B2B SaaS fit";
}

function weakestCategory(c: QualificationResult["categories"]): string {
  return c.compliance_buying_signals.score === 0 ? "No compliance buying signals found" : "Weak overall fit";
}

/**
 * Critical questions still open: not yet answered by evidence AND at least one page type that could answer
 * them hasn't been checked. (The homepage alone never settles a question that has a dedicated page.)
 */
export function missingQuestions(r: Record<string, CriterionResult>, checkedPages: Set<string>): string[] {
  return CRITICAL_QUESTIONS.filter((q) => {
    const unchecked = q.pages.some((p) => !checkedPages.has(p));
    if (q.key === "certified") return !checkedPages.has("security/compliance");
    // Business model needs both SaaS and B2B; the others are answered by any one criterion.
    const answered = q.key === "business_model" ? q.criteria.every((id) => r[id].status === "FOUND") : q.criteria.some((id) => r[id].status === "FOUND");
    return !answered && unchecked;
  }).map((q) => q.question);
}

/** Page types to fetch next, in priority order, for the questions still open (targeted — never random). */
export function researchTargets(result: QualificationResult, checkedPages: Set<string>): string[] {
  const open = new Set(result.missing_information);
  const tags: string[] = [];
  for (const q of CRITICAL_QUESTIONS) {
    if (!open.has(q.question)) continue;
    for (const p of q.pages) if (!checkedPages.has(p) && !tags.includes(p)) tags.push(p);
  }
  // Borderline scores: look for the remaining scoring evidence too.
  if (result.decision === "research_more" && !tags.length) {
    for (const c of CRITERIA) {
      const cr = (Object.values(result.categories) as CategoryResult[]).flatMap((x) => x.criteria).find((x) => x.id === c.id);
      if (cr?.status === "UNKNOWN") for (const p of c.pages) if (!checkedPages.has(p) && !tags.includes(p)) tags.push(p);
    }
  }
  return tags;
}

function nextAction(decision: QualificationResult["decision"], dq: string[], missing: string[]): string {
  if (decision === "qualified") return "Find the decision-maker, identify pain points and draft the email.";
  if (decision === "not_qualified") return dq.length ? `Do not contact — ${dq[0].toLowerCase()}.` : "Do not contact — below the qualification threshold.";
  return missing.length ? `Human review — check: ${missing.join("; ")}` : "Human review — borderline score.";
}

/** When the research budget is spent, a pending "research more" becomes an honest NEEDS_REVIEW. */
export function finalizeUnresolved(r: QualificationResult): QualificationResult {
  if (r.decision !== "research_more") return r;
  return {
    ...r,
    decision: "needs_review",
    explanation: `${r.explanation.replace(/[.—\s]*(checking certification status first|unchecked criteria could change it)\.?$/i, "")} Research limit reached.`.trim(),
    recommended_next_action: nextAction("needs_review", [], r.missing_information),
  };
}
