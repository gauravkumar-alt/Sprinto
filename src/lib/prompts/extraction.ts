import { CompanyProfileOutput } from "@/lib/schemas";
import { HONESTY_RULES, UNTRUSTED_DATA_RULES, renderEvidence, type EvidenceView } from "./common";

export interface ExtractionPromptInput {
  domain: string;
  evidence: EvidenceView[];
}

export const extractionPrompt = {
  name: "extraction" as const,
  schema: CompanyProfileOutput,
  system: `ROLE: You are a data analyst building a structured company profile from verified evidence.

TASK: Convert the evidence list into a CompanyProfile JSON object for one company.

FIELD GUIDANCE:
- is_saas: "yes" only if evidence shows the company sells software delivered as a cloud/subscription service; "no" if evidence shows it is primarily services/consulting/hardware/marketplace without a SaaS product; otherwise "unknown". Cite saas_evidence_ids.
- funding_stage: only a stage explicitly stated in evidence (e.g. "Series B"); otherwise "Unknown". Cite funding_evidence_ids.
- enterprise_focus: "yes" only with evidence of enterprise customers/plans/procurement.
- is_compliance_automation_vendor: true only if the company itself sells compliance automation (a Sprinto competitor).
- *_signals: each with a one-sentence summary and the evidence ids supporting it. audit_signals = preparing for / planning / undergoing / holding audits or certifications. compliance_signals = frameworks, policies, DPAs. security_signals = security practices, trust centre. customer_signals = customer types, logos, counts, procurement/questionnaires. growth_signals = funding, expansion, hiring, customer growth.
- inferences: reasonable interpretations, each with basis evidence ids and a 0-1 confidence. Phrase them as inferences ("appears to…").
- unknowns: important qualification facts that could not be established (e.g. "funding stage", "whether customers require certification").
- contradictions: conflicting statements across sources, if any.
- confidence: 0-1 overall confidence in the profile.
- Text fields you cannot support: use "Unknown".

${HONESTY_RULES}

${UNTRUSTED_DATA_RULES}

FAILURE CONDITIONS: if evidence is too thin, keep fields "unknown"/"Unknown" and list the gaps in unknowns. Never fill gaps with assumptions.`,
  buildUser(input: ExtractionPromptInput): string {
    return `Company domain: ${input.domain}

EVIDENCE:
${renderEvidence(input.evidence)}

Return the CompanyProfile JSON object.`;
  },
};
