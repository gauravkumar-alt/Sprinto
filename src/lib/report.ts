/** Required qualification output format (one JSON object per company). */
import type { CategoryResult, QualificationResult } from "./schemas";

const STATUS: Record<string, string> = { qualified: "QUALIFIED", needs_review: "NEEDS_REVIEW", research_more: "NEEDS_REVIEW", not_qualified: "NOT_QUALIFIED" };

const category = (c: CategoryResult | undefined) => ({
  score: c?.score ?? 0,
  evidence: (c?.criteria ?? []).map((cr) => ({
    criterion: cr.criterion,
    max_points: cr.max_points,
    points_awarded: cr.points,
    status: cr.status,
    evidence_text: cr.evidence.map((e) => e.text),
    source_url: cr.evidence.map((e) => e.source_url).filter(Boolean),
    confidence: cr.confidence,
  })),
});

export function qualificationReport(q: QualificationResult, domain: string, companyName: string | null) {
  return {
    company_name: q.company_name || companyName || domain,
    domain,
    business_description: q.business_description ?? "",
    total_score: q.fit_score,
    qualification_status: STATUS[q.decision] ?? q.decision.toUpperCase(),
    business_model_fit: category(q.categories?.business_model_fit),
    growth_stage: category(q.categories?.growth_stage),
    compliance_buying_signals: category(q.categories?.compliance_buying_signals),
    enterprise_readiness: category(q.categories?.enterprise_readiness),
    existing_certifications: (q.existing_certifications ?? []).map((c) => c.name),
    disqualification_reasons: [...(q.flags ?? []), ...(q.disqualification_reasons ?? [])],
    missing_information: q.missing_information ?? [],
    pages_scraped: q.pages_scraped ?? [],
    research_summary: q.research_summary ?? q.explanation,
    recommended_next_action: q.recommended_next_action ?? "",
  };
}
