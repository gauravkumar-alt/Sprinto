/**
 * Typed contracts between pipeline stages.
 *
 * "LLM output" schemas describe what a model must return; they are deliberately
 * simple (no numeric bounds) so they work with structured outputs, and every
 * value is re-checked deterministically after parsing (evidence ids exist,
 * quotes appear verbatim in the source, confidences are clamped, …).
 */
import { z } from "zod/v4";

// ───────────────────────── shared ─────────────────────────

export const DataSource = z.enum(["real", "mock"]);
export type DataSource = z.infer<typeof DataSource>;

export const EvidenceType = z.enum(["observed", "inference", "unknown"]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const EvidenceCategory = z.enum([
  "company",
  "product",
  "business_model",
  "customers",
  "enterprise",
  "security",
  "compliance",
  "audit",
  "funding",
  "growth",
  "hiring",
  "contact",
]);
export type EvidenceCategory = z.infer<typeof EvidenceCategory>;

/** Evidence as stored and shown in the UI. `ref` is the id shown to models, e.g. "E12". */
export interface EvidenceRecord {
  id: number;
  ref: string;
  companyId: number;
  claim: string;
  supportingText: string;
  sourceUrl: string | null;
  sourceType: "website" | "search_result" | "contact_provider" | "derived" | "manual";
  evidenceType: EvidenceType;
  category: string;
  confidence: number;
  retrievedAt: string | null;
  publishedAt: string | null;
  dataSource: DataSource;
}

// ───────────────────────── Step 1: research ─────────────────────────

export interface ResearchedPage {
  id: number;
  url: string;
  title: string;
  text: string;
  contentHash: string;
  retrievedAt: string;
  publishedAt: string | null;
  round: number;
  sourceType: "website" | "search_result";
  dataSource: DataSource;
}

/** researchPrompt output: atomic, quoted evidence from pages. */
export const ResearchEvidenceOutput = z.object({
  evidence: z.array(
    z.object({
      page_id: z.number(),
      category: EvidenceCategory,
      claim: z.string(),
      quote: z.string(),
      confidence: z.number(),
    }),
  ),
  suspicious_instructions_detected: z.boolean(),
});
export type ResearchEvidenceOutput = z.infer<typeof ResearchEvidenceOutput>;

// ───────────────────────── Step 2: extraction ─────────────────────────

const Signal = z.object({ summary: z.string(), evidence_ids: z.array(z.string()) });
export type Signal = z.infer<typeof Signal>;

export const FundingStage = z.enum([
  "Pre-Seed",
  "Seed",
  "Series A",
  "Series B",
  "Series C",
  "Series D+",
  "Public",
  "Bootstrapped",
  "Other",
  "Unknown",
]);

export const CompanyProfileOutput = z.object({
  company_name: z.string(),
  description: z.string(),
  business_model: z.string(),
  industry: z.string(),
  is_saas: z.enum(["yes", "no", "unknown"]),
  saas_evidence_ids: z.array(z.string()),
  funding_stage: FundingStage,
  funding_evidence_ids: z.array(z.string()),
  company_size: z.string().nullable(),
  target_customer: z.string(),
  enterprise_focus: z.enum(["yes", "no", "unknown"]),
  enterprise_evidence_ids: z.array(z.string()),
  is_compliance_automation_vendor: z.boolean(),
  audit_signals: z.array(Signal),
  compliance_signals: z.array(Signal),
  security_signals: z.array(Signal),
  customer_signals: z.array(Signal),
  growth_signals: z.array(Signal),
  inferences: z.array(
    z.object({ claim: z.string(), basis_evidence_ids: z.array(z.string()), confidence: z.number() }),
  ),
  unknowns: z.array(z.string()),
  contradictions: z.array(z.string()),
  confidence: z.number(),
});
export type CompanyProfileOutput = z.infer<typeof CompanyProfileOutput>;

export type CompanyProfile = CompanyProfileOutput & {
  domain: string;
  source_evidence_ids: string[];
  data_source: DataSource;
  extracted_at: string;
};

// ───────────────────────── Step 3: qualification ─────────────────────────

export const SaasLevel = z.enum(["confirmed", "likely", "not_saas", "unknown"]);
export const StageLevel = z.enum(["series_a_c", "growth_indicators", "other_verified", "unknown"]);
export const AuditLevel = z.enum([
  "active_or_planned",
  "initiative_timing_uncertain",
  "already_certified",
  "generic_material",
  "none",
]);
export const EnterpriseLevel = z.enum([
  "direct_requirement",
  "security_reviews",
  "enterprise_positioning",
  "none",
]);
export type SaasLevel = z.infer<typeof SaasLevel>;
export type StageLevel = z.infer<typeof StageLevel>;
export type AuditLevel = z.infer<typeof AuditLevel>;
export type EnterpriseLevel = z.infer<typeof EnterpriseLevel>;

/** qualificationPrompt output: per-criterion FINDINGS. The model reports facts with evidence; code scores. */
export const CRITERION_IDS = [
  "saas",
  "b2b",
  "product",
  "funding_series_ac",
  "open_roles",
  "enterprise_pricing",
  "preparing_certification",
  "compliance_hiring",
  "enterprise_security_reviews",
  "named_enterprise_customers",
  "targets_enterprise",
] as const;

export const QualificationFindingsOutput = z.object({
  company_name: z.string(),
  business_description: z.string(),
  product_or_service: z.string(),
  is_saas: z.enum(["yes", "no", "unknown"]),
  audience: z.enum(["b2b", "b2c", "both", "unknown"]),
  funding_stage: z.string(),
  open_roles_count: z.number().nullable(),
  criteria: z.array(
    z.object({
      id: z.enum(CRITERION_IDS),
      found: z.boolean(),
      evidence_ids: z.array(z.string()),
      confidence: z.number(),
      note: z.string(),
    }),
  ),
  existing_certifications: z.array(z.object({ name: z.string(), evidence_ids: z.array(z.string()) })),
  outside_target: z.object({ flag: z.boolean(), reason: z.string(), evidence_ids: z.array(z.string()) }),
});
export type QualificationFindings = z.infer<typeof QualificationFindingsOutput>;

export type QualificationDecision = "qualified" | "not_qualified" | "needs_review" | "research_more";
export type CriterionStatus = "FOUND" | "NOT_FOUND" | "UNKNOWN";

export interface CriterionResult {
  id: string;
  criterion: string;
  max_points: number;
  points: number;
  status: CriterionStatus;
  evidence: { ref: string; text: string; source_url: string | null }[];
  confidence: number;
  note: string;
}

export interface CategoryResult {
  label: string;
  score: number;
  max: number;
  criteria: CriterionResult[];
}

export interface QualificationResult {
  decision: QualificationDecision;
  fit_score: number;
  /** Per-category breakdown (100-point rubric). */
  categories: Record<"business_model_fit" | "growth_stage" | "compliance_buying_signals" | "enterprise_readiness", CategoryResult>;
  existing_certifications: { name: string; evidence_refs: string[] }[];
  flags: string[]; // e.g. ALREADY_CERTIFIED
  disqualification_reasons: string[];
  missing_information: string[];
  pages_scraped: string[];
  company_name: string;
  business_description: string;
  research_summary: string;
  recommended_next_action: string;
  // Summary signals derived from the findings (used by contact ranking, pain points, emails).
  saas_status: SaasLevel;
  stage_status: StageLevel;
  stage_label: string;
  audit_trigger: AuditLevel;
  enterprise_pressure: EnterpriseLevel;
  has_buying_trigger: boolean;
  reasons: string[];
  evidence_ids: string[];
  adjustments: string[];
  confidence: number;
  explanation: string;
}

// ───────────────────────── Step 3a: research loop ─────────────────────────

export const MissingInformationOutput = z.object({
  gaps: z.array(z.object({ dimension: z.string(), what_is_missing: z.string() })),
  urls_to_fetch: z.array(z.string()),
  search_queries: z.array(z.string()),
  reasoning_summary: z.string(),
});
export type MissingInformationOutput = z.infer<typeof MissingInformationOutput>;

// ───────────────────────── Step 4: contacts ─────────────────────────

export interface ContactCandidate {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  department: string | null;
  seniority: string | null;
  email: string | null;
  emailType: "personal" | "generic" | null;
  verificationStatus: string | null; // as reported by the provider; null = not reported
  providerConfidence: number | null; // 0-100 as reported by the provider
  sources: { uri: string; extractedOn: string | null }[];
  provider: "hunter" | "mock" | "manual";
  dataSource: DataSource;
}

export const RoleCategory = z.enum([
  "ciso",
  "head_of_security",
  "head_of_compliance",
  "compliance_manager",
  "security_lead",
  "cto",
  "vp_engineering",
  "coo",
  "founder_ceo",
  "irrelevant",
]);
export type RoleCategory = z.infer<typeof RoleCategory>;

/** contactSelectionPrompt output: only used to classify titles the rule table cannot. */
export const ContactClassificationOutput = z.object({
  classifications: z.array(z.object({ index: z.number(), category: RoleCategory, note: z.string() })),
});

export interface RankedContact {
  candidate: ContactCandidate;
  category: RoleCategory;
  score: number;
  reasons: string[];
  eligible: boolean;
}

// ───────────────────────── Step 5: pain points ─────────────────────────

export const PainPointsOutput = z.object({
  insufficient_evidence: z.boolean(),
  pain_points: z.array(
    z.object({
      statement: z.string(),
      why_it_matters_to_this_person: z.string(),
      evidence_ids: z.array(z.string()),
      type: z.enum(["direct", "inferred"]),
      confidence: z.number(),
    }),
  ),
});
export type PainPoint = z.infer<typeof PainPointsOutput>["pain_points"][number];

// ───────────────────────── Step 6: email ─────────────────────────

export const EmailOutput = z.object({
  subject: z.string(),
  body: z.string(),
  prospect_name: z.string(),
  prospect_role: z.string(),
  personalisation_hook: z.string(),
  pain_point_used: z.string(),
  evidence_ids: z.array(z.string()),
  personalisation_explanation: z.string(),
});
export type GeneratedEmail = z.infer<typeof EmailOutput>;

export const EmailCritiqueOutput = z.object({
  verdict: z.enum(["PASS", "REGENERATE"]),
  checks: z.array(z.object({ check: z.string(), passed: z.boolean(), note: z.string() })),
  issues: z.array(z.string()),
});
export type EmailCritique = z.infer<typeof EmailCritiqueOutput>;

// ───────────────────────── status enums ─────────────────────────

export const EMAIL_STATUSES = [
  "pending",
  "generated",
  "validated",
  "sent",
  "simulated",
  "failed",
  "skipped",
  "needs_review",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const COMPANY_OUTCOMES = [
  "pending",
  "running",
  "qualified",
  "not_qualified",
  "needs_review",
  "contact_not_found",
  "email_needs_review",
  "email_sent",
  "email_simulated",
  "failed",
] as const;
export type CompanyOutcome = (typeof COMPANY_OUTCOMES)[number];
