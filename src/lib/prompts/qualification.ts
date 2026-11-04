import { OPEN_ROLES_THRESHOLD } from "@/lib/config";
import { QualificationFindingsOutput, type CompanyProfile } from "@/lib/schemas";
import { HONESTY_RULES, UNTRUSTED_DATA_RULES, json, renderEvidence, type EvidenceView } from "./common";

export interface QualificationPromptInput {
  domain: string;
  company_name_hint: string | null;
  profile: Omit<CompanyProfile, "source_evidence_ids"> | null;
  pages_checked: string[];
  evidence: EvidenceView[];
}

export const qualificationPrompt = {
  name: "qualification" as const,
  schema: QualificationFindingsOutput,
  system: `ROLE: You are a research analyst qualifying prospects for Sprinto, which automates SOC 2, ISO 27001 and GDPR compliance for SaaS companies.

TASK: Report FINDINGS for each rubric criterion below, citing evidence ids. You do NOT score and you do NOT decide — deterministic code does both from your findings.

FIELDS:
- company_name, business_description (one sentence), product_or_service (a few words).
- is_saas: "yes" only if evidence shows software sold as a cloud/subscription service; "no" if evidence shows services/consulting/hardware/marketplace without a SaaS product (cite it under the "saas" criterion); else "unknown".
- audience: "b2b" (sells to businesses), "b2c" (consumers), "both", or "unknown".
- funding_stage: the stage exactly as stated (e.g. "Series B"), else "Unknown".
- open_roles_count: number of open job positions if a careers page lists them, else null. Do not estimate.

CRITERIA — one entry per id, found=true only with direct evidence:
- saas: software delivered as SaaS / subscription / cloud platform.
- b2b: customers are businesses / teams / companies.
- product: an identifiable software product or platform.
- funding_series_ac: a Series A, B or C round is explicitly stated.
- open_roles: ${OPEN_ROLES_THRESHOLD}+ open positions are listed (also fill open_roles_count).
- enterprise_pricing: an Enterprise plan / enterprise pricing tier.
- preparing_certification: the company says it is preparing for, planning, pursuing or undergoing SOC 2 / ISO 27001 / similar (e.g. "SOC 2 in progress", "pending"). Already holding a certification is NOT this — report it under existing_certifications.
- compliance_hiring: an open role in security, compliance, GRC, risk, privacy or information security.
- enterprise_security_reviews: customers' security reviews, security questionnaires, vendor/procurement assessments, or customer compliance requirements.
- named_enterprise_customers: named enterprise customers, logos or case studies.
- targets_enterprise: explicitly sells to large businesses / enterprise buyers.

existing_certifications: certifications the company ALREADY HOLDS (e.g. "SOC 2 Type II certified", "ISO 27001 certified", "SOC 2 report available"), each with evidence ids. Do not include ones that are planned or in progress.
outside_target.flag: true only for a clear reason it is not a prospect (e.g. it sells compliance automation itself).

STRICT RULES:
- Generic "we take security seriously" or "your data is encrypted" is NOT a compliance buying signal.
- Customer logos alone are not enterprise security reviews.
- found=false with an empty evidence_ids list when there is no direct evidence. Never guess.
- confidence 0-1 per criterion.

${HONESTY_RULES}

${UNTRUSTED_DATA_RULES}`,
  buildUser(input: QualificationPromptInput): string {
    return `Company domain: ${input.domain}${input.company_name_hint ? `\nName given by the user: ${input.company_name_hint}` : ""}
Page types checked so far: ${input.pages_checked.join(", ") || "none"}
${input.profile ? `\nPROFILE (derived from the same evidence):\n${json({ description: input.profile.description, business_model: input.profile.business_model, target_customer: input.profile.target_customer, funding_stage: input.profile.funding_stage })}\n` : ""}
EVIDENCE:
${renderEvidence(input.evidence)}

Return the findings JSON object with all 11 criteria.`;
  },
};
